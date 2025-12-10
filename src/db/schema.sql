-- Cakehouse Marketing Platform Database Schema
-- Multi-tenant, compliant SMS & Email marketing

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Enable Row Level Security helper
CREATE OR REPLACE FUNCTION set_current_tenant(tenant_id UUID)
RETURNS VOID AS $$
BEGIN
  PERFORM set_config('app.current_tenant', tenant_id::TEXT, FALSE);
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- TENANTS (White-label clients)
-- ============================================
CREATE TABLE tenants (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(100) UNIQUE NOT NULL, -- e.g., 'cakehouse', 'clientb'
  domain VARCHAR(255), -- Custom domain for white-label
  
  -- Branding
  logo_url VARCHAR(500),
  primary_color VARCHAR(7) DEFAULT '#4F46E5',
  
  -- Contact
  company_name VARCHAR(255) NOT NULL,
  company_address TEXT NOT NULL, -- Required for CAN-SPAM
  support_email VARCHAR(255),
  support_phone VARCHAR(20),
  
  -- Settings
  settings JSONB DEFAULT '{}',
  
  -- Status
  status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'cancelled')),
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- USERS (Dashboard access per tenant)
-- ============================================
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  
  email VARCHAR(255) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  name VARCHAR(255),
  role VARCHAR(50) DEFAULT 'user' CHECK (role IN ('owner', 'admin', 'user', 'viewer')),
  
  last_login_at TIMESTAMPTZ,
  status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'invited', 'suspended')),
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  
  UNIQUE(tenant_id, email)
);

-- ============================================
-- LOCATIONS (Dispensary locations per tenant)
-- ============================================
CREATE TABLE locations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  
  name VARCHAR(255) NOT NULL,
  address TEXT,
  city VARCHAR(100),
  state VARCHAR(2) NOT NULL, -- Important for state-specific compliance
  zip VARCHAR(10),
  timezone VARCHAR(50) DEFAULT 'America/Los_Angeles',
  
  -- Phone numbers for this location
  sms_phone_number VARCHAR(20), -- Telnyx number
  sms_phone_number_id VARCHAR(100), -- Telnyx phone number ID
  
  -- POS Integration
  pos_type VARCHAR(50), -- 'treez', 'iheart_jane', 'dutchie', etc.
  pos_config JSONB DEFAULT '{}',
  
  status VARCHAR(20) DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- CONTACTS (Subscribers/customers)
-- ============================================
CREATE TABLE contacts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  
  -- Contact info
  phone VARCHAR(20),
  email VARCHAR(255),
  first_name VARCHAR(100),
  last_name VARCHAR(100),
  
  -- Location association (optional)
  primary_location_id UUID REFERENCES locations(id) ON DELETE SET NULL,
  
  -- Compliance - SMS
  sms_consent BOOLEAN DEFAULT FALSE,
  sms_consent_at TIMESTAMPTZ,
  sms_consent_method VARCHAR(50), -- 'web_form', 'pos_checkout', 'keyword', etc.
  sms_consent_ip VARCHAR(45),
  sms_opted_out BOOLEAN DEFAULT FALSE,
  sms_opted_out_at TIMESTAMPTZ,
  
  -- Compliance - Email
  email_consent BOOLEAN DEFAULT FALSE,
  email_consent_at TIMESTAMPTZ,
  email_consent_method VARCHAR(50),
  email_opted_out BOOLEAN DEFAULT FALSE,
  email_opted_out_at TIMESTAMPTZ,
  
  -- Age verification (REQUIRED for cannabis)
  age_verified BOOLEAN DEFAULT FALSE,
  age_verified_at TIMESTAMPTZ,
  age_verification_method VARCHAR(50), -- 'checkbox', 'id_scan', 'pos_verified'
  date_of_birth DATE,
  
  -- Segmentation
  tags TEXT[] DEFAULT '{}',
  custom_fields JSONB DEFAULT '{}',
  
  -- Stats
  total_orders INTEGER DEFAULT 0,
  total_spent DECIMAL(10,2) DEFAULT 0,
  last_order_at TIMESTAMPTZ,
  
  -- Timezone for quiet hours
  timezone VARCHAR(50),
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  
  UNIQUE(tenant_id, phone),
  UNIQUE(tenant_id, email)
);

CREATE INDEX idx_contacts_tenant_phone ON contacts(tenant_id, phone);
CREATE INDEX idx_contacts_tenant_email ON contacts(tenant_id, email);
CREATE INDEX idx_contacts_sms_consent ON contacts(tenant_id, sms_consent, sms_opted_out);
CREATE INDEX idx_contacts_email_consent ON contacts(tenant_id, email_consent, email_opted_out);
CREATE INDEX idx_contacts_tags ON contacts USING GIN(tags);

-- ============================================
-- CAMPAIGNS
-- ============================================
CREATE TABLE campaigns (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  
  name VARCHAR(255) NOT NULL,
  type VARCHAR(20) NOT NULL CHECK (type IN ('sms', 'email', 'both')),
  status VARCHAR(20) DEFAULT 'draft' CHECK (status IN ('draft', 'scheduled', 'sending', 'sent', 'paused', 'cancelled')),
  
  -- Content
  sms_content TEXT,
  email_subject VARCHAR(255),
  email_content TEXT, -- HTML
  email_plain_text TEXT,
  
  -- Targeting
  target_all BOOLEAN DEFAULT FALSE,
  target_locations UUID[] DEFAULT '{}',
  target_tags TEXT[] DEFAULT '{}',
  target_filter JSONB DEFAULT '{}', -- Advanced filtering
  
  -- Scheduling
  scheduled_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  
  -- Stats
  total_recipients INTEGER DEFAULT 0,
  sent_count INTEGER DEFAULT 0,
  delivered_count INTEGER DEFAULT 0,
  failed_count INTEGER DEFAULT 0,
  opened_count INTEGER DEFAULT 0,
  clicked_count INTEGER DEFAULT 0,
  opted_out_count INTEGER DEFAULT 0,
  
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- MESSAGES (Individual message log)
-- ============================================
CREATE TABLE messages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  
  campaign_id UUID REFERENCES campaigns(id) ON DELETE SET NULL,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  location_id UUID REFERENCES locations(id) ON DELETE SET NULL,
  
  type VARCHAR(10) NOT NULL CHECK (type IN ('sms', 'email')),
  direction VARCHAR(10) DEFAULT 'outbound' CHECK (direction IN ('inbound', 'outbound')),
  
  -- Content
  to_address VARCHAR(255) NOT NULL, -- Phone or email
  from_address VARCHAR(255),
  subject VARCHAR(255), -- Email only
  content TEXT NOT NULL,
  
  -- Status tracking
  status VARCHAR(30) DEFAULT 'queued' CHECK (status IN (
    'queued', 'sending', 'sent', 'delivered', 'failed', 
    'bounced', 'complained', 'opened', 'clicked'
  )),
  status_updated_at TIMESTAMPTZ,
  
  -- Provider tracking
  provider VARCHAR(20), -- 'telnyx', 'ses'
  provider_message_id VARCHAR(255),
  provider_status VARCHAR(50),
  provider_error TEXT,
  
  -- Compliance audit
  consent_verified_at TIMESTAMPTZ,
  quiet_hours_checked_at TIMESTAMPTZ,
  
  -- Costs
  cost_cents INTEGER DEFAULT 0,
  segments INTEGER DEFAULT 1, -- SMS segments
  
  sent_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  opened_at TIMESTAMPTZ,
  clicked_at TIMESTAMPTZ,
  
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_messages_tenant ON messages(tenant_id);
CREATE INDEX idx_messages_campaign ON messages(campaign_id);
CREATE INDEX idx_messages_contact ON messages(contact_id);
CREATE INDEX idx_messages_provider_id ON messages(provider_message_id);
CREATE INDEX idx_messages_status ON messages(tenant_id, status);
CREATE INDEX idx_messages_created ON messages(tenant_id, created_at DESC);

-- ============================================
-- OPT-OUT LOG (Compliance audit trail)
-- ============================================
CREATE TABLE opt_out_log (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  
  channel VARCHAR(10) NOT NULL CHECK (channel IN ('sms', 'email')),
  address VARCHAR(255) NOT NULL, -- Phone or email
  action VARCHAR(20) NOT NULL CHECK (action IN ('opt_out', 'opt_in')),
  
  -- How it happened
  method VARCHAR(50) NOT NULL, -- 'keyword_reply', 'link_click', 'manual', 'import'
  keyword VARCHAR(20), -- e.g., 'STOP'
  source_message_id UUID REFERENCES messages(id),
  
  -- Audit
  ip_address VARCHAR(45),
  user_agent TEXT,
  
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_opt_out_tenant_address ON opt_out_log(tenant_id, address);

-- ============================================
-- AUTOMATION WORKFLOWS
-- ============================================
CREATE TABLE automations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  
  name VARCHAR(255) NOT NULL,
  trigger_type VARCHAR(50) NOT NULL, -- 'new_contact', 'purchase', 'birthday', 'inactivity', etc.
  trigger_config JSONB DEFAULT '{}',
  
  -- Actions
  actions JSONB NOT NULL DEFAULT '[]', -- Array of action steps
  
  -- Targeting
  target_locations UUID[] DEFAULT '{}',
  target_tags TEXT[] DEFAULT '{}',
  
  status VARCHAR(20) DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'paused')),
  
  -- Stats
  triggered_count INTEGER DEFAULT 0,
  sent_count INTEGER DEFAULT 0,
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- GLOBAL OPT-OUT LIST (Cross-tenant for carriers)
-- ============================================
CREATE TABLE global_opt_outs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  phone VARCHAR(20) UNIQUE NOT NULL,
  opted_out_at TIMESTAMPTZ DEFAULT NOW(),
  source_tenant_id UUID REFERENCES tenants(id)
);

CREATE INDEX idx_global_opt_outs_phone ON global_opt_outs(phone);

-- ============================================
-- API KEYS (For POS integrations, etc.)
-- ============================================
CREATE TABLE api_keys (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  
  name VARCHAR(255) NOT NULL,
  key_hash VARCHAR(255) NOT NULL, -- Hashed API key
  key_prefix VARCHAR(10) NOT NULL, -- First few chars for identification
  
  permissions JSONB DEFAULT '["read", "write"]',
  
  last_used_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  status VARCHAR(20) DEFAULT 'active',
  
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- ROW LEVEL SECURITY POLICIES
-- ============================================

-- Enable RLS on tenant-scoped tables
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE opt_out_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE automations ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;

-- Create policies (example for contacts, repeat pattern for other tables)
CREATE POLICY tenant_isolation_contacts ON contacts
  FOR ALL
  USING (tenant_id::TEXT = current_setting('app.current_tenant', TRUE));

CREATE POLICY tenant_isolation_users ON users
  FOR ALL
  USING (tenant_id::TEXT = current_setting('app.current_tenant', TRUE));

CREATE POLICY tenant_isolation_locations ON locations
  FOR ALL
  USING (tenant_id::TEXT = current_setting('app.current_tenant', TRUE));

CREATE POLICY tenant_isolation_campaigns ON campaigns
  FOR ALL
  USING (tenant_id::TEXT = current_setting('app.current_tenant', TRUE));

CREATE POLICY tenant_isolation_messages ON messages
  FOR ALL
  USING (tenant_id::TEXT = current_setting('app.current_tenant', TRUE));

CREATE POLICY tenant_isolation_opt_out_log ON opt_out_log
  FOR ALL
  USING (tenant_id::TEXT = current_setting('app.current_tenant', TRUE));

CREATE POLICY tenant_isolation_automations ON automations
  FOR ALL
  USING (tenant_id::TEXT = current_setting('app.current_tenant', TRUE));

CREATE POLICY tenant_isolation_api_keys ON api_keys
  FOR ALL
  USING (tenant_id::TEXT = current_setting('app.current_tenant', TRUE));

-- ============================================
-- UPDATED_AT TRIGGER
-- ============================================
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_tenants_updated_at BEFORE UPDATE ON tenants FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER update_locations_updated_at BEFORE UPDATE ON locations FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER update_contacts_updated_at BEFORE UPDATE ON contacts FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER update_campaigns_updated_at BEFORE UPDATE ON campaigns FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER update_automations_updated_at BEFORE UPDATE ON automations FOR EACH ROW EXECUTE FUNCTION update_updated_at();
