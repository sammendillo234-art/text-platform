require('dotenv').config();

module.exports = {
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT, 10) || 3000,
  apiBaseUrl: process.env.API_BASE_URL || 'http://localhost:3000',

  database: {
    url: process.env.DATABASE_URL,
    pool: {
      min: 2,
      max: 10
    }
  },

  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379'
  },

  telnyx: {
    apiKey: process.env.TELNYX_API_KEY,
    publicKey: process.env.TELNYX_PUBLIC_KEY,
    messagingProfileId: process.env.TELNYX_MESSAGING_PROFILE_ID
  },

  aws: {
    region: process.env.AWS_REGION || 'us-west-2',
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    ses: {
      fromEmail: process.env.SES_FROM_EMAIL
    }
  },

  jwt: {
    secret: process.env.JWT_SECRET,
    expiresIn: process.env.JWT_EXPIRES_IN || '7d'
  },

  compliance: {
    quietHours: {
      start: process.env.DEFAULT_QUIET_HOURS_START || '21:00',
      end: process.env.DEFAULT_QUIET_HOURS_END || '08:00'
    },
    maxMessagesPerDayPerRecipient: parseInt(process.env.MAX_MESSAGES_PER_DAY_PER_RECIPIENT, 10) || 3,
    optOutKeywords: ['STOP', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT'],
    optInKeywords: ['START', 'YES', 'SUBSCRIBE', 'UNSTOP']
  },

  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 15 * 60 * 1000,
    max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS, 10) || 100
  }
};
