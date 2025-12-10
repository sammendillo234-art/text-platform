const { Queue, Worker, QueueScheduler } = require('bullmq');
const config = require('../../../config');
const telnyxService = require('../sms/telnyx');
const compliance = require('../compliance');
const logger = require('../../utils/logger');

// Redis connection
const connection = {
  host: new URL(config.redis.url).hostname,
  port: parseInt(new URL(config.redis.url).port, 10) || 6379
};

// Create queues
const smsQueue = new Queue('sms-messages', { connection });
const emailQueue = new Queue('email-messages', { connection });
const campaignQueue = new Queue('campaigns', { connection });

// Queue scheduler (handles delayed jobs)
const smsScheduler = new QueueScheduler('sms-messages', { connection });
const emailScheduler = new QueueScheduler('email-messages', { connection });

/**
 * Add SMS to queue
 */
async function queueSMS({ tenantId, contactId, locationId, content, campaignId, delay = 0 }) {
  const job = await smsQueue.add(
    'send-sms',
    { tenantId, contactId, locationId, content, campaignId },
    {
      delay,
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 5000
      },
      removeOnComplete: 1000,
      removeOnFail: 5000
    }
  );

  logger.info('SMS queued', { jobId: job.id, tenantId, contactId });
  return job;
}

/**
 * Add SMS to queue with quiet hours handling
 */
async function queueSMSWithQuietHours({ tenantId, contactId, locationId, content, campaignId }) {
  // Check quiet hours
  const complianceResult = await compliance.checkMessage(tenantId, contactId, 'sms');
  
  if (!complianceResult.approved) {
    // Check if it's specifically quiet hours
    if (!complianceResult.checks.quietHours && complianceResult.contact) {
      // Calculate delay until quiet hours end
      const retryAfter = compliance.checkQuietHours(complianceResult.contact).retryAfter;
      if (retryAfter) {
        const delay = new Date(retryAfter).getTime() - Date.now();
        return queueSMS({ tenantId, contactId, locationId, content, campaignId, delay });
      }
    }
    
    // Other compliance failure - don't queue
    return { blocked: true, reasons: complianceResult.reasons };
  }

  // No delay needed
  return queueSMS({ tenantId, contactId, locationId, content, campaignId });
}

/**
 * Queue a campaign for processing
 */
async function queueCampaign({ tenantId, campaignId }) {
  const job = await campaignQueue.add(
    'process-campaign',
    { tenantId, campaignId },
    {
      attempts: 1,
      removeOnComplete: 100
    }
  );

  logger.info('Campaign queued', { jobId: job.id, tenantId, campaignId });
  return job;
}

/**
 * SMS Worker - processes SMS jobs
 */
function startSMSWorker() {
  const worker = new Worker(
    'sms-messages',
    async (job) => {
      const { tenantId, contactId, locationId, content, campaignId } = job.data;
      
      logger.info('Processing SMS job', { jobId: job.id, tenantId, contactId });
      
      const result = await telnyxService.sendMessage({
        tenantId,
        contactId,
        locationId,
        content,
        campaignId
      });

      if (!result.success && result.blocked) {
        // Don't retry if blocked by compliance
        logger.warn('SMS blocked by compliance', { jobId: job.id, reasons: result.reasons });
        return result;
      }

      if (!result.success) {
        throw new Error(result.error || 'SMS send failed');
      }

      return result;
    },
    {
      connection,
      concurrency: 10, // Process up to 10 SMS at a time
      limiter: {
        max: 100,      // Max 100 jobs
        duration: 1000 // per second (adjust based on Telnyx rate limits)
      }
    }
  );

  worker.on('completed', (job, result) => {
    logger.info('SMS job completed', { jobId: job.id, result });
  });

  worker.on('failed', (job, error) => {
    logger.error('SMS job failed', { jobId: job.id, error: error.message });
  });

  return worker;
}

/**
 * Campaign Worker - processes campaign batches
 */
function startCampaignWorker() {
  const worker = new Worker(
    'campaigns',
    async (job) => {
      const { tenantId, campaignId } = job.data;
      const db = require('../../db');
      
      logger.info('Processing campaign', { jobId: job.id, tenantId, campaignId });
      
      // Get campaign details
      const campaignResult = await db.queryWithTenant(tenantId, `
        SELECT * FROM campaigns WHERE id = $1
      `, [campaignId]);

      if (campaignResult.rows.length === 0) {
        throw new Error('Campaign not found');
      }

      const campaign = campaignResult.rows[0];

      // Build recipient query based on targeting
      let recipientQuery = `
        SELECT c.id, c.phone, c.email, c.primary_location_id
        FROM contacts c
        WHERE c.tenant_id = $1
      `;
      const queryParams = [tenantId];

      // Add consent filters
      if (campaign.type === 'sms' || campaign.type === 'both') {
        recipientQuery += ` AND c.sms_consent = TRUE AND c.sms_opted_out = FALSE`;
      }
      if (campaign.type === 'email' || campaign.type === 'both') {
        recipientQuery += ` AND c.email_consent = TRUE AND c.email_opted_out = FALSE`;
      }

      // Age verification required
      recipientQuery += ` AND c.age_verified = TRUE`;

      // Location targeting
      if (campaign.target_locations && campaign.target_locations.length > 0) {
        recipientQuery += ` AND c.primary_location_id = ANY($${queryParams.length + 1})`;
        queryParams.push(campaign.target_locations);
      }

      // Tag targeting
      if (campaign.target_tags && campaign.target_tags.length > 0) {
        recipientQuery += ` AND c.tags && $${queryParams.length + 1}`;
        queryParams.push(campaign.target_tags);
      }

      const recipients = await db.queryWithTenant(tenantId, recipientQuery, queryParams);

      logger.info('Campaign recipients found', { 
        campaignId, 
        count: recipients.rows.length 
      });

      // Update campaign status and recipient count
      await db.queryWithTenant(tenantId, `
        UPDATE campaigns 
        SET status = 'sending', 
            total_recipients = $1,
            started_at = NOW()
        WHERE id = $2
      `, [recipients.rows.length, campaignId]);

      // Queue messages for each recipient
      for (const recipient of recipients.rows) {
        if (campaign.type === 'sms' && recipient.phone) {
          await queueSMSWithQuietHours({
            tenantId,
            contactId: recipient.id,
            locationId: recipient.primary_location_id,
            content: campaign.sms_content,
            campaignId
          });
        }
        
        // TODO: Add email queueing when email service is implemented
      }

      // Mark campaign as sent (workers will update individual stats)
      await db.queryWithTenant(tenantId, `
        UPDATE campaigns 
        SET status = 'sent', completed_at = NOW()
        WHERE id = $1
      `, [campaignId]);

      return { recipients: recipients.rows.length };
    },
    {
      connection,
      concurrency: 2
    }
  );

  worker.on('completed', (job, result) => {
    logger.info('Campaign job completed', { jobId: job.id, result });
  });

  worker.on('failed', (job, error) => {
    logger.error('Campaign job failed', { jobId: job.id, error: error.message });
  });

  return worker;
}

/**
 * Get queue statistics
 */
async function getQueueStats() {
  const [smsWaiting, smsActive, smsCompleted, smsFailed] = await Promise.all([
    smsQueue.getWaitingCount(),
    smsQueue.getActiveCount(),
    smsQueue.getCompletedCount(),
    smsQueue.getFailedCount()
  ]);

  return {
    sms: {
      waiting: smsWaiting,
      active: smsActive,
      completed: smsCompleted,
      failed: smsFailed
    }
  };
}

module.exports = {
  smsQueue,
  emailQueue,
  campaignQueue,
  queueSMS,
  queueSMSWithQuietHours,
  queueCampaign,
  startSMSWorker,
  startCampaignWorker,
  getQueueStats
};
