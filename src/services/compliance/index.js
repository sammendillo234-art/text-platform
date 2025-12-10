const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
const config = require('../../../config');
const db = require('../db');
const logger = require('../utils/logger');

dayjs.extend(utc);
dayjs.extend(timezone);

class ComplianceEngine {
  constructor() {
    this.optOutKeywords = config.compliance.optOutKeywords;
    this.optInKeywords = config.compliance.optInKeywords;
    this.maxMessagesPerDay = config.compliance.maxMessagesPerDayPerRecipient;
  }

  /**
   * Full compliance check before sending a message
   * Returns { approved: boolean, reasons: string[], contact: object }
   */
  async checkMessage(tenantId, contactId, messageType = 'sms') {
    const reasons = [];
    
    // Get contact with all compliance data
    const contactResult = await db.queryWithTenant(tenantId, `
      SELECT c.*, l.state, l.timezone as location_timezone
      FROM contacts c
      LEFT JOIN locations l ON c.primary_location_id = l.id
      WHERE c.id = $1
    `, [contactId]);

    if (contactResult.rows.length === 0) {
      return { approved: false, reasons: ['Contact not found'], contact: null };
    }

    const contact = contactResult.rows[0];

    // 1. Check consent
    const consentCheck = this.checkConsent(contact, messageType);
    if (!consentCheck.approved) reasons.push(...consentCheck.reasons);

    // 2. Check opt-out status
    const optOutCheck = this.checkOptOut(contact, messageType);
    if (!optOutCheck.approved) reasons.push(...optOutCheck.reasons);

    // 3. Check age verification
    const ageCheck = this.checkAgeVerification(contact);
    if (!ageCheck.approved) reasons.push(...ageCheck.reasons);

    // 4. Check global opt-out (for SMS)
    if (messageType === 'sms' && contact.phone) {
      const globalOptOut = await this.checkGlobalOptOut(contact.phone);
      if (!globalOptOut.approved) reasons.push(...globalOptOut.reasons);
    }

    // 5. Check quiet hours (for SMS)
    if (messageType === 'sms') {
      const quietHoursCheck = this.checkQuietHours(contact);
      if (!quietHoursCheck.approved) reasons.push(...quietHoursCheck.reasons);
    }

    // 6. Check rate limiting
    const rateLimitCheck = await this.checkRateLimit(tenantId, contactId, messageType);
    if (!rateLimitCheck.approved) reasons.push(...rateLimitCheck.reasons);

    // 7. State-specific rules
    const stateCheck = this.checkStateRules(contact.state, messageType);
    if (!stateCheck.approved) reasons.push(...stateCheck.reasons);

    return {
      approved: reasons.length === 0,
      reasons,
      contact,
      checks: {
        consent: consentCheck.approved,
        optOut: optOutCheck.approved,
        ageVerification: ageCheck.approved,
        quietHours: messageType === 'sms' ? this.checkQuietHours(contact).approved : true,
        rateLimit: rateLimitCheck.approved,
        stateRules: stateCheck.approved
      }
    };
  }

  /**
   * Check if contact has valid consent
   */
  checkConsent(contact, messageType) {
    if (messageType === 'sms') {
      if (!contact.sms_consent) {
        return { approved: false, reasons: ['No SMS consent on file'] };
      }
      if (!contact.sms_consent_at) {
        return { approved: false, reasons: ['SMS consent timestamp missing'] };
      }
    } else if (messageType === 'email') {
      if (!contact.email_consent) {
        return { approved: false, reasons: ['No email consent on file'] };
      }
    }
    return { approved: true, reasons: [] };
  }

  /**
   * Check if contact has opted out
   */
  checkOptOut(contact, messageType) {
    if (messageType === 'sms' && contact.sms_opted_out) {
      return { approved: false, reasons: ['Contact has opted out of SMS'] };
    }
    if (messageType === 'email' && contact.email_opted_out) {
      return { approved: false, reasons: ['Contact has opted out of email'] };
    }
    return { approved: true, reasons: [] };
  }

  /**
   * Check age verification (REQUIRED for cannabis)
   */
  checkAgeVerification(contact) {
    if (!contact.age_verified) {
      return { approved: false, reasons: ['Age not verified (21+ required)'] };
    }
    
    // If DOB is on file, double-check they're 21+
    if (contact.date_of_birth) {
      const age = dayjs().diff(dayjs(contact.date_of_birth), 'year');
      if (age < 21) {
        return { approved: false, reasons: ['Contact is under 21'] };
      }
    }
    
    return { approved: true, reasons: [] };
  }

  /**
   * Check global opt-out list (carrier-level)
   */
  async checkGlobalOptOut(phone) {
    const result = await db.query(
      'SELECT id FROM global_opt_outs WHERE phone = $1',
      [this.normalizePhone(phone)]
    );
    
    if (result.rows.length > 0) {
      return { approved: false, reasons: ['Phone number on global opt-out list'] };
    }
    return { approved: true, reasons: [] };
  }

  /**
   * Check quiet hours based on recipient timezone
   */
  checkQuietHours(contact) {
    const tz = contact.timezone || contact.location_timezone || 'America/Los_Angeles';
    const now = dayjs().tz(tz);
    const currentTime = now.format('HH:mm');
    
    const quietStart = config.compliance.quietHours.start; // e.g., '21:00'
    const quietEnd = config.compliance.quietHours.end;     // e.g., '08:00'
    
    // Check if current time is in quiet hours
    // Handle overnight quiet hours (e.g., 21:00 - 08:00)
    let inQuietHours = false;
    if (quietStart > quietEnd) {
      // Overnight period
      inQuietHours = currentTime >= quietStart || currentTime < quietEnd;
    } else {
      inQuietHours = currentTime >= quietStart && currentTime < quietEnd;
    }
    
    if (inQuietHours) {
      return { 
        approved: false, 
        reasons: [`Quiet hours in effect (${quietStart} - ${quietEnd} ${tz})`],
        retryAfter: this.getQuietHoursEnd(tz)
      };
    }
    
    return { approved: true, reasons: [] };
  }

  /**
   * Calculate when quiet hours end
   */
  getQuietHoursEnd(tz) {
    const [hours, minutes] = config.compliance.quietHours.end.split(':');
    let endTime = dayjs().tz(tz).hour(parseInt(hours)).minute(parseInt(minutes)).second(0);
    
    // If end time has passed today, it's tomorrow
    if (endTime.isBefore(dayjs().tz(tz))) {
      endTime = endTime.add(1, 'day');
    }
    
    return endTime.toISOString();
  }

  /**
   * Check rate limiting per recipient
   */
  async checkRateLimit(tenantId, contactId, messageType) {
    const result = await db.queryWithTenant(tenantId, `
      SELECT COUNT(*) as count
      FROM messages
      WHERE contact_id = $1
        AND type = $2
        AND direction = 'outbound'
        AND created_at > NOW() - INTERVAL '24 hours'
    `, [contactId, messageType]);

    const count = parseInt(result.rows[0].count, 10);
    
    if (count >= this.maxMessagesPerDay) {
      return { 
        approved: false, 
        reasons: [`Rate limit exceeded (${count}/${this.maxMessagesPerDay} messages in 24h)`] 
      };
    }
    
    return { approved: true, reasons: [] };
  }

  /**
   * State-specific cannabis advertising rules
   */
  checkStateRules(state, messageType) {
    const rules = {
      CA: {
        // California: Can't advertise to anyone under 21, need age gate
        // All good if we've verified age
      },
      MI: {
        // Michigan: Similar to CA, licensed retailers can advertise
      },
      CO: {
        // Colorado: Strict rules on content, can't be "appealing to children"
      }
    };

    // For now, pass if we've done other checks
    // This can be expanded with content scanning for state-specific prohibited terms
    return { approved: true, reasons: [] };
  }

  /**
   * Check if inbound message is an opt-out
   */
  isOptOutMessage(text) {
    const normalized = text.trim().toUpperCase();
    return this.optOutKeywords.includes(normalized);
  }

  /**
   * Check if inbound message is an opt-in (re-subscribe)
   */
  isOptInMessage(text) {
    const normalized = text.trim().toUpperCase();
    return this.optInKeywords.includes(normalized);
  }

  /**
   * Process an opt-out
   */
  async processOptOut(tenantId, phone, channel, method, sourceMessageId = null) {
    const normalizedPhone = this.normalizePhone(phone);
    
    // Find the contact
    const contactResult = await db.queryWithTenant(tenantId, `
      SELECT id FROM contacts WHERE phone = $1
    `, [normalizedPhone]);

    let contactId = null;
    if (contactResult.rows.length > 0) {
      contactId = contactResult.rows[0].id;
      
      // Update contact opt-out status
      const field = channel === 'sms' ? 'sms_opted_out' : 'email_opted_out';
      const atField = channel === 'sms' ? 'sms_opted_out_at' : 'email_opted_out_at';
      
      await db.queryWithTenant(tenantId, `
        UPDATE contacts 
        SET ${field} = TRUE, ${atField} = NOW()
        WHERE id = $1
      `, [contactId]);
    }

    // Log the opt-out
    await db.queryWithTenant(tenantId, `
      INSERT INTO opt_out_log (tenant_id, contact_id, channel, address, action, method, source_message_id)
      VALUES ($1, $2, $3, $4, 'opt_out', $5, $6)
    `, [tenantId, contactId, channel, normalizedPhone, method, sourceMessageId]);

    // Add to global opt-out list (for SMS)
    if (channel === 'sms') {
      await db.query(`
        INSERT INTO global_opt_outs (phone, source_tenant_id)
        VALUES ($1, $2)
        ON CONFLICT (phone) DO NOTHING
      `, [normalizedPhone, tenantId]);
    }

    logger.info(`Opt-out processed: ${normalizedPhone} from ${channel}`, { tenantId, contactId });
    
    return { success: true, contactId };
  }

  /**
   * Process an opt-in (re-subscribe)
   */
  async processOptIn(tenantId, phone, channel, method) {
    const normalizedPhone = this.normalizePhone(phone);
    
    const contactResult = await db.queryWithTenant(tenantId, `
      SELECT id FROM contacts WHERE phone = $1
    `, [normalizedPhone]);

    if (contactResult.rows.length === 0) {
      return { success: false, error: 'Contact not found' };
    }

    const contactId = contactResult.rows[0].id;
    
    // Update contact status
    const field = channel === 'sms' ? 'sms_opted_out' : 'email_opted_out';
    const consentField = channel === 'sms' ? 'sms_consent' : 'email_consent';
    const consentAtField = channel === 'sms' ? 'sms_consent_at' : 'email_consent_at';
    
    await db.queryWithTenant(tenantId, `
      UPDATE contacts 
      SET ${field} = FALSE, ${consentField} = TRUE, ${consentAtField} = NOW()
      WHERE id = $1
    `, [contactId]);

    // Log the opt-in
    await db.queryWithTenant(tenantId, `
      INSERT INTO opt_out_log (tenant_id, contact_id, channel, address, action, method)
      VALUES ($1, $2, $3, $4, 'opt_in', $5)
    `, [tenantId, contactId, channel, normalizedPhone, method]);

    // Remove from global opt-out (for SMS)
    if (channel === 'sms') {
      await db.query('DELETE FROM global_opt_outs WHERE phone = $1', [normalizedPhone]);
    }

    logger.info(`Opt-in processed: ${normalizedPhone} to ${channel}`, { tenantId, contactId });
    
    return { success: true, contactId };
  }

  /**
   * Scan message content for compliance issues
   */
  scanContent(content, state = null) {
    const issues = [];
    const contentLower = content.toLowerCase();
    
    // Check for health claims (prohibited)
    const healthClaims = [
      'cure', 'treat', 'heal', 'medical benefit', 'health benefit',
      'prevents', 'reduces risk', 'therapeutic'
    ];
    
    for (const term of healthClaims) {
      if (contentLower.includes(term)) {
        issues.push(`Potential health claim detected: "${term}"`);
      }
    }

    // Check for terms that might appeal to minors
    const minorAppealing = [
      'candy', 'cartoon', 'kid', 'child', 'toy', 'school'
    ];
    
    for (const term of minorAppealing) {
      if (contentLower.includes(term)) {
        issues.push(`Term that may appeal to minors: "${term}"`);
      }
    }

    return {
      approved: issues.length === 0,
      issues
    };
  }

  /**
   * Normalize phone number to E.164 format
   */
  normalizePhone(phone) {
    // Remove all non-digits
    let digits = phone.replace(/\D/g, '');
    
    // Add country code if missing (assume US)
    if (digits.length === 10) {
      digits = '1' + digits;
    }
    
    return '+' + digits;
  }

  /**
   * Create audit log entry for compliance
   */
  async logComplianceCheck(tenantId, messageId, checks, approved) {
    // This could write to a separate audit table if needed
    logger.info('Compliance check completed', {
      tenantId,
      messageId,
      approved,
      checks
    });
  }
}

module.exports = new ComplianceEngine();
