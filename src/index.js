require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const config = require('../config');
const logger = require('./utils/logger');

// Import webhook handlers
const { handleTelnyxWebhook } = require('./webhooks/telnyx');

// Import queue workers
const { startSMSWorker, startCampaignWorker } = require('./services/queue');

const app = express();

// ============================================
// MIDDLEWARE
// ============================================

// Security headers
app.use(helmet());

// CORS
app.use(cors({
  origin: config.env === 'production' 
    ? ['https://yourdomain.com', 'https://app.yourdomain.com']
    : '*',
  credentials: true
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.max,
  message: { error: 'Too many requests, please try again later.' }
});
app.use('/api/', limiter);

// Body parsing - raw body needed for webhook signature verification
app.use('/webhooks/telnyx', express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

// Standard JSON parsing for other routes
app.use(express.json());

// Request logging
app.use((req, res, next) => {
  logger.info(`${req.method} ${req.path}`, { 
    ip: req.ip,
    userAgent: req.get('user-agent')
  });
  next();
});

// ============================================
// WEBHOOKS (No auth required, signature verified)
// ============================================

app.post('/webhooks/telnyx', handleTelnyxWebhook);

// ============================================
// HEALTH CHECK
// ============================================

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    version: require('../package.json').version
  });
});

// ============================================
// API ROUTES
// ============================================

// Import route modules
const apiRouter = express.Router();

// Tenant context middleware (for authenticated routes)
apiRouter.use(async (req, res, next) => {
  // TODO: Extract tenant from JWT token
  // For now, allow tenant_id in header for testing
  const tenantId = req.headers['x-tenant-id'];
  if (tenantId) {
    req.tenantId = tenantId;
  }
  next();
});

// Contacts API
apiRouter.get('/contacts', async (req, res) => {
  try {
    const db = require('./db');
    if (!req.tenantId) {
      return res.status(401).json({ error: 'Tenant ID required' });
    }
    
    const result = await db.queryWithTenant(req.tenantId, `
      SELECT id, phone, email, first_name, last_name, 
             sms_consent, email_consent, age_verified, tags,
             created_at
      FROM contacts 
      ORDER BY created_at DESC 
      LIMIT 100
    `);
    
    res.json({ contacts: result.rows });
  } catch (error) {
    logger.error('Failed to fetch contacts', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch contacts' });
  }
});

apiRouter.post('/contacts', async (req, res) => {
  try {
    const db = require('./db');
    const compliance = require('./services/compliance');
    
    if (!req.tenantId) {
      return res.status(401).json({ error: 'Tenant ID required' });
    }
    
    const { 
      phone, email, first_name, last_name,
      sms_consent, email_consent, age_verified,
      location_id, tags
    } = req.body;

    // Normalize phone
    const normalizedPhone = phone ? compliance.normalizePhone(phone) : null;

    const result = await db.queryWithTenant(req.tenantId, `
      INSERT INTO contacts (
        tenant_id, phone, email, first_name, last_name,
        sms_consent, sms_consent_at, sms_consent_method,
        email_consent, email_consent_at, email_consent_method,
        age_verified, age_verified_at, age_verification_method,
        primary_location_id, tags
      ) VALUES (
        $1, $2, $3, $4, $5,
        $6, CASE WHEN $6 THEN NOW() ELSE NULL END, CASE WHEN $6 THEN 'api' ELSE NULL END,
        $7, CASE WHEN $7 THEN NOW() ELSE NULL END, CASE WHEN $7 THEN 'api' ELSE NULL END,
        $8, CASE WHEN $8 THEN NOW() ELSE NULL END, CASE WHEN $8 THEN 'api' ELSE NULL END,
        $9, $10
      )
      RETURNING id
    `, [
      req.tenantId, normalizedPhone, email, first_name, last_name,
      sms_consent || false, email_consent || false, age_verified || false,
      location_id, tags || []
    ]);

    res.status(201).json({ 
      success: true, 
      contactId: result.rows[0].id 
    });
  } catch (error) {
    logger.error('Failed to create contact', { error: error.message });
    res.status(500).json({ error: 'Failed to create contact' });
  }
});

// Send SMS API
apiRouter.post('/sms/send', async (req, res) => {
  try {
    const { queueSMSWithQuietHours } = require('./services/queue');
    
    if (!req.tenantId) {
      return res.status(401).json({ error: 'Tenant ID required' });
    }
    
    const { contact_id, location_id, content } = req.body;

    if (!contact_id || !content) {
      return res.status(400).json({ error: 'contact_id and content required' });
    }

    const result = await queueSMSWithQuietHours({
      tenantId: req.tenantId,
      contactId: contact_id,
      locationId: location_id,
      content
    });

    if (result.blocked) {
      return res.status(422).json({ 
        success: false, 
        blocked: true,
        reasons: result.reasons 
      });
    }

    res.json({ 
      success: true, 
      jobId: result.id,
      message: 'SMS queued for delivery' 
    });
  } catch (error) {
    logger.error('Failed to queue SMS', { error: error.message });
    res.status(500).json({ error: 'Failed to queue SMS' });
  }
});

// Campaigns API
apiRouter.post('/campaigns', async (req, res) => {
  try {
    const db = require('./db');
    
    if (!req.tenantId) {
      return res.status(401).json({ error: 'Tenant ID required' });
    }
    
    const { 
      name, type, sms_content, email_subject, email_content,
      target_all, target_locations, target_tags, scheduled_at
    } = req.body;

    const result = await db.queryWithTenant(req.tenantId, `
      INSERT INTO campaigns (
        tenant_id, name, type, sms_content, email_subject, email_content,
        target_all, target_locations, target_tags, scheduled_at,
        status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'draft')
      RETURNING id
    `, [
      req.tenantId, name, type, sms_content, email_subject, email_content,
      target_all || false, target_locations || [], target_tags || [],
      scheduled_at
    ]);

    res.status(201).json({ 
      success: true, 
      campaignId: result.rows[0].id 
    });
  } catch (error) {
    logger.error('Failed to create campaign', { error: error.message });
    res.status(500).json({ error: 'Failed to create campaign' });
  }
});

apiRouter.post('/campaigns/:id/send', async (req, res) => {
  try {
    const { queueCampaign } = require('./services/queue');
    const db = require('./db');
    
    if (!req.tenantId) {
      return res.status(401).json({ error: 'Tenant ID required' });
    }
    
    const campaignId = req.params.id;

    // Update status to scheduled
    await db.queryWithTenant(req.tenantId, `
      UPDATE campaigns SET status = 'scheduled' WHERE id = $1
    `, [campaignId]);

    // Queue for processing
    const job = await queueCampaign({
      tenantId: req.tenantId,
      campaignId
    });

    res.json({ 
      success: true, 
      jobId: job.id,
      message: 'Campaign queued for sending' 
    });
  } catch (error) {
    logger.error('Failed to send campaign', { error: error.message });
    res.status(500).json({ error: 'Failed to send campaign' });
  }
});

// Queue stats
apiRouter.get('/queue/stats', async (req, res) => {
  try {
    const { getQueueStats } = require('./services/queue');
    const stats = await getQueueStats();
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: 'Failed to get queue stats' });
  }
});

app.use('/api', apiRouter);

// ============================================
// ERROR HANDLING
// ============================================

app.use((err, req, res, next) => {
  logger.error('Unhandled error', { error: err.message, stack: err.stack });
  res.status(500).json({ error: 'Internal server error' });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ============================================
// START SERVER
// ============================================

const PORT = config.port;

async function start() {
  try {
    // Start queue workers
    logger.info('Starting queue workers...');
    startSMSWorker();
    startCampaignWorker();
    logger.info('Queue workers started');

    // Start HTTP server
    app.listen(PORT, () => {
      logger.info(`Server running on port ${PORT}`);
      logger.info(`Webhook URL: ${config.apiBaseUrl}/webhooks/telnyx`);
    });
  } catch (error) {
    logger.error('Failed to start server', { error: error.message });
    process.exit(1);
  }
}

start();

module.exports = app;
