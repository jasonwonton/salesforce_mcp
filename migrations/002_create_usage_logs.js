exports.up = function(knex) {
  return knex.schema.createTable('usage_logs', table => {
    table.increments('id').primary();
    table.string('team_id').references('id').inTable('teams').onDelete('CASCADE');
    table.string('slack_user_id').notNullable();
    table.string('command').notNullable();
    table.text('query_text');
    table.integer('results_count');
    table.timestamps(true, true);
  });
};

exports.down = function(knex) {
  return knex.schema.dropTable('usage_logs');
};