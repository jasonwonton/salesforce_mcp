exports.up = function(knex) {
  return knex.schema.createTable('teams', table => {
    table.string('id').primary();
    table.string('name').notNullable();
    table.string('slack_access_token').notNullable();
    table.string('slack_bot_token').notNullable();
    table.string('slack_user_id').notNullable();
    table.string('salesforce_instance_url');
    table.text('salesforce_access_token');
    table.text('salesforce_refresh_token');
    table.string('salesforce_client_id');
    table.text('salesforce_client_secret');
    table.boolean('is_active').defaultTo(true);
    table.timestamps(true, true);
  });
};

exports.down = function(knex) {
  return knex.schema.dropTable('teams');
};