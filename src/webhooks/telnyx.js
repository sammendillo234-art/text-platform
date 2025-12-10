const crypto = require('crypto');
const config = require('../../config');
const telnyxService = require('../services/sms/telnyx');
const logger = require('../utils/logger');

/**
 * Verify Telnyx webhook signature
 * https://developers.telnyx.com/docs/v2/development/webhooks#verifying-webhooks
 */
function verifySignature(req) {
  const signature = req.headers['telnyx-signature-ed25519'];
  const timestamp = req.headers['telnyx-timestamp'];
  
  if (!signature || !timestamp) {
    return false;
  }

  // For production, implement full Ed25519 verification
  // For now, check if signature exists
  // TODO: Implement proper Ed25519 signature verification
  
  // Check timestamp is recent (within 5 minutes)
  const timestampDate = new Date(timestamp);
  const now = new Date();
  const fiveMinutes = 5 * 60 * 1000;
  
  if (Math.abs(now - timestampDate) > fiveMinutes) {
    logger.warn('Telnyx webhook timestamp too old', { timestamp });
    return false;
  }

  return true;
}

/**
 * Main Telnyx webhook handler
 */
async function handleTelnyxWebhook(req, res) {
  // Respond immediately to acknowledge receipt
  res.status(200).send('OK');

  try {
    // Verify signature in production
    if (config.env === 'production') {
      if (!verifySignature(req)) {
        logger.warn('Invalid Telnyx webhook signature');
        return;
      }
    }

    const { data } = req.body;
    
    if (!data) {
      logger.warn('Telnyx webhook missing data payload');
      return;
    }

    const eventType = data.event_type;
    const payload = data.payload;

    logger.info('Telnyx webhook received', { eventType, messageId: payload?.id });

    switch (eventType) {
      // Outbound message status updates
      case 'message.sent':
        await handleMessageSent(payload);
        break;

      case 'message.finalized':
        await handleMessageFinalized(payload);
        break;

      // Inbound messages
      case 'message.received':
        await handleMessageReceived(payload);
        break;

      // Delivery status
      case 'message.delivered':
        await handleMessageDelivered(payload);
        break;

      case 'message.failed':
      case 'message.delivery_failed':
        await handleMessageFailed(payload);
        break;

      default:
        logger.info('Unhandled Telnyx event type', { eventType });
    }

  } catch (error) {
    logger.error('Telnyx webhook processing error', { error: error.message, stack: error.stack });
  }
}

/**
 * Handle message.sent event
 */
async function handleMessageSent(payload) {
  await telnyxService.updateMessageStatus({
    telnyxMessageId: payload.id,
    status: 'sent'
  });
}

/**
 * Handle message.finalized event (final delivery status)
 */
async function handleMessageFinalized(payload) {
  const status = payload.to?.[0]?.status || 'unknown';
  
  await telnyxService.updateMessageStatus({
    telnyxMessageId: payload.id,
    status: status === 'delivered' ? 'delivered' : 'sent',
    errorCode: payload.errors?.[0]?.code,
    errorMessage: payload.errors?.[0]?.title
  });
}

/**
 * Handle inbound message
 */
async function handleMessageReceived(payload) {
  const from = payload.from?.phone_number;
  const to = payload.to?.[0]?.phone_number || payload.to;
  const text = payload.text;
  const telnyxMessageId = payload.id;

  if (!from || !text) {
    logger.warn('Inbound message missing required fields', { payload });
    return;
  }

  await telnyxService.handleInbound({
    from,
    to,
    text,
    telnyxMessageId
  });
}

/**
 * Handle message.delivered event
 */
async function handleMessageDelivered(payload) {
  await telnyxService.updateMessageStatus({
    telnyxMessageId: payload.id,
    status: 'delivered'
  });
}

/**
 * Handle message.failed event
 */
async function handleMessageFailed(payload) {
  const error = payload.errors?.[0];
  
  await telnyxService.updateMessageStatus({
    telnyxMessageId: payload.id,
    status: 'failed',
    errorCode: error?.code,
    errorMessage: error?.title || error?.detail
  });
}

module.exports = {
  handleTelnyxWebhook,
  verifySignature
};
