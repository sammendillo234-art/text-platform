const { Pool } = require('pg');
const config = require('../../config');

const pool = new Pool({
  connectionString: config.database.url,
  min: config.database.pool.min,
  max: config.database.pool.max
});

// Set tenant context for row-level security
async function setTenant(client, tenantId) {
  await client.query(`SELECT set_config('app.current_tenant', $1, FALSE)`, [tenantId]);
}

// Get a client with tenant context set
async function getClientWithTenant(tenantId) {
  const client = await pool.connect();
  await setTenant(client, tenantId);
  return client;
}

// Query helper with automatic tenant context
async function queryWithTenant(tenantId, text, params) {
  const client = await getClientWithTenant(tenantId);
  try {
    return await client.query(text, params);
  } finally {
    client.release();
  }
}

// Simple query without tenant context (for global tables like tenants)
async function query(text, params) {
  return pool.query(text, params);
}

// Transaction helper with tenant context
async function transactionWithTenant(tenantId, callback) {
  const client = await getClientWithTenant(tenantId);
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  pool,
  query,
  queryWithTenant,
  transactionWithTenant,
  getClientWithTenant,
  setTenant
};
