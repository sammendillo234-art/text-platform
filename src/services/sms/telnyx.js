const Telnyx = require('telnyx');
const config = require('../../../config');
const db = require('../../db');
const compliance = require('../compliance');
const logger = require('../../utils/logger');

const telnyx = Telnyx(config.telnyx.apiKey);

class TelnyxService {
  /**
   * Send an SMS message with full compliance checking
   */
  async sendMessage({ tenantId, contactId, locationId, content, campaignId = null }) {
    // 1. Run compliance checks
    const complianceResult = await compliance.checkMessage(tenantId, contactId, 'sms');
    
    if (!complianceResult.approved) {
      logger.warn('Message blocked by compliance', { 
        tenantId, 
        contactId, 
        reasons: complianceResult.reasons 
      });
      
      return {
        success: false,
        blocked: true,
        reasons: complianceResult.reasons
      };
    }

    const contact = complianceResult.contact;

    // 2. Content compliance scan
    const contentScan = compliance.scanContent(content, contact.state);
    if (!contentScan.approved) {
      logger.warn('Message content flagged', { 
        tenantId, 
        contactId, 
        issues: contentScan.issues 
      });
      // Log but don't block - let user review
    }

    // 3. Get location's phone number
    let fromNumber;
    if (locationId) {
      const locationResult = await db.queryWithTenant(tenantId, `
        SELECT sms_phone_number FROM locations WHERE id = $1
      `, [locationId]);
      
      if (locationResult.rows.length > 0 && locationResult.rows[0].sms_phone_number) {
        fromNumber = locationResult.rows[0].sms_phone_number;
      }
    }

    // Fallback to messaging profile if no location number
    const messagingProfileId = config.telnyx.messagingProfileId;

    // 4. Create message record
    const messageResult = await db.queryWithTenant(tenantId, `
      INSERT INTO messages (
        tenant_id, campaign_id, contact_id, location_id,
        type, direction, to_address, from_address, content,
        status, provider, consent_verified_at, quiet_hours_checked_at
      ) VALUES ($1, $2, $3, $4, 'sms', 'outbound', $5, $6, $7, 'queued', 'telnyx', NOW(), NOW())
      RETURNING id
    `, [tenantId, campaignId, contactId, locationId, contact.phone, fromNumber, content]);

    const messageId = messageResult.rows[0].id;

    // 5. Send via Telnyx
    try {
      const telnyxParams = {
        to: contact.phone,
        text: content
      };

      // Use either a specific from number or messaging profile
      if (fromNumber) {
        telnyxParams.from = fromNumber;
      } else {
        telnyxParams.messaging_profile_id = messagingProfileId;
      }

      const response = await telnyx.messages.create(telnyxParams);

      // 6. Update message with Telnyx response
      await db.queryWithTenant(tenantId, `
        UPDATE messages SET
          provider_message_id = $1,
          status = 'sent',
          sent_at = NOW(),
          segments = $2
        WHERE id = $3
      `, [response.data.id, response.data.parts || 1, messageId]);

      logger.info('SMS sent successfully', { 
        tenantId, 
        messageId, 
        telnyxId: response.data.id 
      });

      return {
        success: true,
        messageId,
        telnyxId: response.data.id,
        segments: response.data.parts || 1
      };

    } catch (error) {
      // Update message as failed
      await db.queryWithTenant(tenantId, `
        UPDATE messages SET
          status = 'failed',
          provider_error = $1
        WHERE id = $2
      `, [error.message, messageId]);

      logger.error('SMS send failed', { 
        tenantId, 
        messageId, 
        error: error.message 
      });

      return {
        success: false,
        messageId,
        error: error.message
      };
    }
  }

  /**
   * Handle inbound SMS (replies, opt-outs)
   */
  async handleInbound({ from, to, text, telnyxMessageId }) {
    const normalizedFrom = compliance.normalizePhone(from);
    const normalizedTo = compliance.normalizePhone(to);

    logger.info('Inbound SMS received', { from: normalizedFrom, to: normalizedTo, text });

    // Find the tenant and location by the "to" number
    const locationResult = await db.query(`
      SELECT l.id as location_id, l.tenant_id, l.name as location_name
      FROM locations l
      WHERE l.sms_phone_number = $1
    `, [normalizedTo]);

    if (locationResult.rows.length === 0) {
      logger.warn('Inbound SMS to unknown number', { to: normalizedTo });
      return { success: false, error: 'Unknown destination number' };
    }

    const { location_id, tenant_id } = locationResult.rows[0];

    // Find or create contact
    let contactResult = await db.queryWithTenant(tenant_id, `
      SELECT id FROM contacts WHERE phone = $1
    `, [normalizedFrom]);

    let contactId = null;
    if (contactResult.rows.length > 0) {
      contactId = contactResult.rows[0].id;
    }

    // Log the inbound message
    const messageResult = await db.queryWithTenant(tenant_id, `
      INSERT INTO messages (
        tenant_id, contact_id, location_id,
        type, direction, to_address, from_address, content,
        status, provider, provider_message_id
      ) VALUES ($1, $2, $3, 'sms', 'inbound', $4, $5, $6, 'delivered', 'telnyx', $7)
      RETURNING id
    `, [tenant_id, contactId, location_id, normalizedTo, normalizedFrom, text, telnyxMessageId]);

    const messageId = messageResult.rows[0].id;

    // Check for opt-out keywords
    if (compliance.isOptOutMessage(text)) {
      await compliance.processOptOut(
        tenant_id, 
        normalizedFrom, 
        'sms', 
        'keyword_reply', 
        messageId
      );

      // Send opt-out confirmation
      await this.sendOptOutConfirmation(tenant_id, normalizedFrom, normalizedTo);
      
      return { 
        success: true, 
        action: 'opt_out', 
        messageId 
      };
    }

    // Check for opt-in keywords
    if (compliance.isOptInMessage(text)) {
      await compliance.processOptIn(
        tenant_id, 
        normalizedFrom, 
        'sms', 
        'keyword_reply'
      );

      // Send opt-in confirmation
      await this.sendOptInConfirmation(tenant_id, normalizedFrom, normalizedTo);
      
      return { 
        success: true, 
        action: 'opt_in', 
        messageId 
      };
    }

    // Regular inbound message - could trigger automation here
    return { 
      success: true, 
      action: 'received', 
      messageId,
      tenantId: tenant_id,
      contactId
    };
  }

  /**
   * Send opt-out confirmation (TCPA required)
   */
  async sendOptOutConfirmation(tenantId, to, from) {
    try {
      await telnyx.messages.create({
        to,
        from,
        text: 'You have been unsubscribed and will no longer receive messages. Reply START to re-subscribe.'
      });
      logger.info('Opt-out confirmation sent', { to });
    } catch (error) {
      logger.error('Failed to send opt-out confirmation', { to, error: error.message });
    }
  }

  /**
   * Send opt-in confirmation
   */
  async sendOptInConfirmation(tenantId, to, from) {
    try {
      await telnyx.messages.create({
        to,
        from,
        text: 'You have been re-subscribed to messages. Reply STOP to unsubscribe at any time.'
      });
      logger.info('Opt-in confirmation sent', { to });
    } catch (error) {
      logger.error('Failed to send opt-in confirmation', { to, error: error.message });
    }
  }

  /**
   * Update message status from webhook
   */
  async updateMessageStatus({ telnyxMessageId, status, errorCode, errorMessage }) {
    // Map Telnyx status to our status
    const statusMap = {
      'queued': 'queued',
      'sending': 'sending',
      'sent': 'sent',
      'delivered': 'delivered',
      'delivery_failed': 'failed',
      'delivery_unconfirmed': 'sent'
    };

    const mappedStatus = statusMap[status] || status;

    const result = await db.query(`
      UPDATE messages SET
        status = $1,
        provider_status = $2,
        provider_error = $3,
        status_updated_at = NOW(),
        delivered_at = CASE WHEN $1 = 'delivered' THEN NOW() ELSE delivered_at END
      WHERE provider_message_id = $4
      RETURNING id, tenant_id, campaign_id
    `, [mappedStatus, status, errorMessage, telnyxMessageId]);

    if (result.rows.length > 0) {
      const { id, tenant_id, campaign_id } = result.rows[0];
      
      // Update campaign stats if applicable
      if (campaign_id) {
        await this.updateCampaignStats(tenant_id, campaign_id, mappedStatus);
      }

      logger.info('Message status updated', { 
        messageId: id, 
        status: mappedStatus 
      });
    }

    return result.rows[0];
  }

  /**
   * Update campaign statistics
   */
  async updateCampaignStats(tenantId, campaignId, status) {
    const fieldMap = {
      'sent': 'sent_count',
      'delivered': 'delivered_count',
      'failed': 'failed_count'
    };

    const field = fieldMap[status];
    if (!field) return;

    await db.queryWithTenant(tenantId, `
      UPDATE campaigns SET ${field} = ${field} + 1 WHERE id = $1
    `, [campaignId]);
  }

  /**
   * Get available phone numbers from Telnyx
   */
  async searchPhoneNumbers({ areaCode, state, limit = 10 }) {
    try {
      const response = await telnyx.availablePhoneNumbers.list({
        filter: {
          country_code: 'US',
          national_destination_code: areaCode,
          administrative_area: state,
          features: ['sms', 'mms'],
          limit
        }
      });
      return response.data;
    } catch (error) {
      logger.error('Phone number search failed', { error: error.message });
      throw error;
    }
  }

  /**
   * Purchase a phone number
   */
  async purchasePhoneNumber(phoneNumber, messagingProfileId) {
    try {
      const response = await telnyx.numberOrders.create({
        phone_numbers: [{ phone_number: phoneNumber }],
        messaging_profile_id: messagingProfileId
      });
      return response.data;
    } catch (error) {
      logger.error('Phone number purchase failed', { phoneNumber, error: error.message });
      throw error;
    }
  }
}

module.exports = new TelnyxService();
