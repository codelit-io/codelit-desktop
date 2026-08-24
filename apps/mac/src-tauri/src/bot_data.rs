use crate::crypto::DataCipher;
use crate::storage::AppState;
use chrono::{DateTime, NaiveDate, SecondsFormat, Utc};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::collections::{HashMap, HashSet};

const BOT_DATABASE_SCHEMA_VERSION: u32 = 1;
const MAX_TABLES_PER_BOT: usize = 12;
const MAX_COLUMNS_PER_TABLE: usize = 16;
const MAX_ROWS_PER_TABLE: i64 = 1_000;
const MAX_OPEN_ROWS: i64 = 200;
const MAX_CELL_CHARS: usize = 2_000;
const MAX_ROW_BYTES: usize = 32 * 1024;
const MAX_BOT_DATABASE_BYTES: i64 = 8 * 1024 * 1024;
const MANAGED_DATABASE_PATH: &str = "managed:encrypted";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BotDataColumn {
    pub name: String,
    pub r#type: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalBotTable {
    pub id: String,
    pub database_id: String,
    pub bot_id: String,
    pub name: String,
    pub version: i64,
    pub columns: Vec<BotDataColumn>,
    pub row_count: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalBotTableRow {
    pub id: String,
    pub values: Map<String, Value>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalBotTableView {
    pub table: LocalBotTable,
    pub rows: Vec<LocalBotTableRow>,
    pub total_rows: i64,
    pub truncated: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateLocalBotTableRequest {
    pub id: String,
    pub bot_id: String,
    pub name: String,
    pub columns: Vec<BotDataColumn>,
    pub created_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppendLocalBotTableRowRequest {
    pub id: String,
    pub bot_id: String,
    pub table_id: String,
    pub values: Map<String, Value>,
    pub created_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BotTableCsvExport {
    pub file_name: String,
    pub data: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BotDatabaseSchema {
    schema_version: u32,
    revision: i64,
    tables: Vec<BotTableSchema>,
    migrations: Vec<BotSchemaMigration>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BotTableSchema {
    id: String,
    name: String,
    version: i64,
    columns: Vec<BotDataColumn>,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BotSchemaMigration {
    version: i64,
    kind: String,
    table_id: String,
    summary: String,
    created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PortableBotDatabase {
    pub(crate) id: String,
    pub(crate) bot_id: String,
    pub(crate) name: String,
    pub(crate) schema: Value,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PortableBotDatabaseRow {
    pub(crate) database_id: String,
    pub(crate) table_id: String,
    pub(crate) row_id: String,
    pub(crate) body: Value,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
}

pub(crate) fn migrate(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_bot_databases_bot
                ON bot_databases(bot_id);
             CREATE TABLE IF NOT EXISTS bot_database_rows (
                database_id TEXT NOT NULL REFERENCES bot_databases(id) ON DELETE CASCADE,
                table_id TEXT NOT NULL,
                row_id TEXT NOT NULL,
                body_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (database_id, table_id, row_id)
             );
             CREATE INDEX IF NOT EXISTS idx_bot_database_rows_created
                ON bot_database_rows(database_id, table_id, created_at DESC);",
        )
        .map_err(error_text)?;
    connection
        .execute(
            "INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (19, ?1)",
            params![canonical_now()],
        )
        .map_err(error_text)?;
    Ok(())
}

pub fn list_local_bot_tables(state: &AppState, bot_id: &str) -> Result<Vec<LocalBotTable>, String> {
    validate_identifier(bot_id, "bot")?;
    let connection = state.connection()?;
    require_bot(&connection, bot_id)?;
    let Some((database_id, schema, _, _)) =
        load_database_schema(&connection, state.cipher(), bot_id)?
    else {
        return Ok(Vec::new());
    };
    table_records(&connection, &database_id, bot_id, &schema)
}

pub fn create_local_bot_table(
    state: &AppState,
    request: CreateLocalBotTableRequest,
) -> Result<LocalBotTableView, String> {
    validate_identifier(&request.id, "table")?;
    validate_identifier(&request.bot_id, "bot")?;
    let name = validate_display_name(&request.name, 64, "table")?;
    let columns = validate_columns(request.columns)?;
    let created_at = canonical_time(&request.created_at, "creation time")?;
    reject_sensitive_label(&name)?;
    for column in &columns {
        reject_sensitive_label(&column.name)?;
    }

    let database_id = format!("bot-database:{}", request.bot_id);
    let mut connection = state.connection()?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(error_text)?;
    require_bot(&transaction, &request.bot_id)?;
    let existing =
        load_database_schema_from_transaction(&transaction, state.cipher(), &request.bot_id)?;
    let (mut schema, database_created_at) = existing
        .as_ref()
        .map(|(_, schema, created_at, _)| (schema.clone(), created_at.clone()))
        .unwrap_or_else(|| {
            (
                BotDatabaseSchema {
                    schema_version: BOT_DATABASE_SCHEMA_VERSION,
                    revision: 0,
                    tables: Vec::new(),
                    migrations: Vec::new(),
                },
                created_at.clone(),
            )
        });
    validate_database_schema(&schema)?;
    if schema.tables.len() >= MAX_TABLES_PER_BOT {
        return Err("This bot already has the maximum of 12 local tables.".into());
    }
    if schema.tables.iter().any(|table| table.id == request.id) {
        return Err("That local table already exists.".into());
    }
    if schema
        .tables
        .iter()
        .any(|table| table.name.eq_ignore_ascii_case(&name))
    {
        return Err("This bot already has a table with that name.".into());
    }
    schema.revision += 1;
    schema.tables.push(BotTableSchema {
        id: request.id.clone(),
        name: name.clone(),
        version: 1,
        columns: columns.clone(),
        created_at: created_at.clone(),
        updated_at: created_at.clone(),
    });
    schema.migrations.push(BotSchemaMigration {
        version: schema.revision,
        kind: "create-table".into(),
        table_id: request.id.clone(),
        summary: format!("Created {name} with {} columns", columns.len()),
        created_at: created_at.clone(),
    });
    validate_database_schema(&schema)?;
    let schema_json = serde_json::to_string(&schema).map_err(error_text)?;
    let sealed_schema = state
        .cipher()
        .seal(&database_schema_context(&database_id), &schema_json)?;
    enforce_database_size(&transaction, &database_id, sealed_schema.len() as i64, 0)?;
    transaction
        .execute(
            "INSERT INTO bot_databases
                (id, bot_id, name, relative_path, schema_json, created_at, updated_at)
             VALUES (?1, ?2, 'Local data', ?3, ?4, ?5, ?6)
             ON CONFLICT(bot_id) DO UPDATE SET
                schema_json = excluded.schema_json,
                updated_at = excluded.updated_at",
            params![
                database_id,
                request.bot_id,
                MANAGED_DATABASE_PATH,
                sealed_schema,
                database_created_at,
                created_at,
            ],
        )
        .map_err(error_text)?;
    record_data_event(
        &transaction,
        state.cipher(),
        &request.bot_id,
        "data.table-created",
        json!({
            "tableId": request.id,
            "columnCount": columns.len(),
            "schemaRevision": schema.revision,
            "createdAt": created_at,
        }),
        &created_at,
    )?;
    transaction.commit().map_err(error_text)?;
    open_local_bot_table(state, &request.bot_id, &request.id, MAX_OPEN_ROWS)
}

pub fn append_local_bot_table_row(
    state: &AppState,
    request: AppendLocalBotTableRowRequest,
) -> Result<LocalBotTableView, String> {
    validate_identifier(&request.id, "row")?;
    validate_identifier(&request.bot_id, "bot")?;
    validate_identifier(&request.table_id, "table")?;
    let created_at = canonical_time(&request.created_at, "creation time")?;
    let mut connection = state.connection()?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(error_text)?;
    require_bot(&transaction, &request.bot_id)?;
    let (database_id, mut schema, _, _) =
        load_database_schema_from_transaction(&transaction, state.cipher(), &request.bot_id)?
            .ok_or_else(|| "Create a local table before adding a row.".to_string())?;
    let table = schema
        .tables
        .iter_mut()
        .find(|table| table.id == request.table_id)
        .ok_or_else(|| "That local table is no longer available to this bot.".to_string())?;
    let values = validate_row_values(&table.columns, request.values)?;
    let row_count: i64 = transaction
        .query_row(
            "SELECT COUNT(*) FROM bot_database_rows WHERE database_id = ?1 AND table_id = ?2",
            params![database_id, request.table_id],
            |row| row.get(0),
        )
        .map_err(error_text)?;
    if row_count >= MAX_ROWS_PER_TABLE {
        return Err(
            "This local table has reached its 1,000 row limit. Export it before adding more."
                .into(),
        );
    }
    let body = json!({ "values": values });
    let body_json = serde_json::to_string(&body).map_err(error_text)?;
    if body_json.len() > MAX_ROW_BYTES {
        return Err("That row is too large for a local table.".into());
    }
    let sealed_body = state.cipher().seal(
        &database_row_context(&database_id, &request.table_id, &request.id),
        &body_json,
    )?;
    table.updated_at = created_at.clone();
    let schema_json = serde_json::to_string(&schema).map_err(error_text)?;
    let sealed_schema = state
        .cipher()
        .seal(&database_schema_context(&database_id), &schema_json)?;
    enforce_database_size(
        &transaction,
        &database_id,
        sealed_schema.len() as i64,
        sealed_body.len() as i64,
    )?;
    transaction
        .execute(
            "INSERT INTO bot_database_rows
                (database_id, table_id, row_id, body_json, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
            params![
                database_id,
                request.table_id,
                request.id,
                sealed_body,
                created_at
            ],
        )
        .map_err(|error| {
            if error.to_string().contains("UNIQUE constraint failed") {
                "That local table row already exists.".to_string()
            } else {
                error_text(error)
            }
        })?;
    transaction
        .execute(
            "UPDATE bot_databases SET schema_json = ?2, updated_at = ?3
             WHERE id = ?1 AND bot_id = ?4",
            params![database_id, sealed_schema, created_at, request.bot_id],
        )
        .map_err(error_text)?;
    record_data_event(
        &transaction,
        state.cipher(),
        &request.bot_id,
        "data.row-added",
        json!({
            "tableId": request.table_id,
            "rowId": request.id,
            "columnCount": body["values"].as_object().map_or(0, Map::len),
            "createdAt": created_at,
        }),
        &created_at,
    )?;
    transaction.commit().map_err(error_text)?;
    open_local_bot_table(state, &request.bot_id, &request.table_id, MAX_OPEN_ROWS)
}

pub fn open_local_bot_table(
    state: &AppState,
    bot_id: &str,
    table_id: &str,
    limit: i64,
) -> Result<LocalBotTableView, String> {
    open_local_bot_table_with_limit(state, bot_id, table_id, limit, MAX_OPEN_ROWS)
}

fn open_local_bot_table_with_limit(
    state: &AppState,
    bot_id: &str,
    table_id: &str,
    limit: i64,
    maximum: i64,
) -> Result<LocalBotTableView, String> {
    validate_identifier(bot_id, "bot")?;
    validate_identifier(table_id, "table")?;
    if !(1..=maximum).contains(&limit) {
        return Err(format!(
            "Local table reads support between 1 and {maximum} rows."
        ));
    }
    let connection = state.connection()?;
    require_bot(&connection, bot_id)?;
    let (database_id, schema, _, _) = load_database_schema(&connection, state.cipher(), bot_id)?
        .ok_or_else(|| "That bot does not have local tables yet.".to_string())?;
    let mut table = table_records(&connection, &database_id, bot_id, &schema)?
        .into_iter()
        .find(|table| table.id == table_id)
        .ok_or_else(|| "That local table is no longer available to this bot.".to_string())?;
    let total_rows = table.row_count;
    let mut statement = connection
        .prepare(
            "SELECT row_id, body_json, created_at, updated_at
             FROM bot_database_rows
             WHERE database_id = ?1 AND table_id = ?2
             ORDER BY created_at DESC, row_id ASC LIMIT ?3",
        )
        .map_err(error_text)?;
    let rows = statement
        .query_map(params![database_id, table_id, limit], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })
        .map_err(error_text)?;
    let mut values = Vec::new();
    for row in rows {
        let (id, stored_body, created_at, updated_at) = row.map_err(error_text)?;
        let body = open_json(
            state.cipher(),
            &database_row_context(&database_id, table_id, &id),
            &stored_body,
        )?;
        let row_values = body
            .get("values")
            .and_then(Value::as_object)
            .cloned()
            .ok_or_else(|| "A local table row is damaged.".to_string())?;
        let row_values = validate_row_values(&table.columns, row_values)?;
        values.push(LocalBotTableRow {
            id,
            values: row_values,
            created_at: canonical_time(&created_at, "row creation time")?,
            updated_at: canonical_time(&updated_at, "row update time")?,
        });
    }
    table.row_count = total_rows;
    Ok(LocalBotTableView {
        table,
        rows: values,
        total_rows,
        truncated: total_rows > limit,
    })
}

pub fn export_local_bot_table_csv(
    state: &AppState,
    bot_id: &str,
    table_id: &str,
) -> Result<BotTableCsvExport, String> {
    let view = open_local_bot_table_with_limit(
        state,
        bot_id,
        table_id,
        MAX_ROWS_PER_TABLE,
        MAX_ROWS_PER_TABLE,
    )?;
    let mut lines = Vec::with_capacity(view.rows.len() + 1);
    lines.push(
        view.table
            .columns
            .iter()
            .map(|column| csv_cell(&column.name))
            .collect::<Vec<_>>()
            .join(","),
    );
    for row in view.rows.iter().rev() {
        lines.push(
            view.table
                .columns
                .iter()
                .map(|column| csv_cell(&display_cell(row.values.get(&column.name))))
                .collect::<Vec<_>>()
                .join(","),
        );
    }
    let file_stem = view
        .table
        .name
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_lowercase();
    Ok(BotTableCsvExport {
        file_name: format!(
            "{}.csv",
            if file_stem.is_empty() {
                "codelit-table"
            } else {
                &file_stem
            }
        ),
        data: format!("{}\n", lines.join("\n")),
    })
}

pub(crate) fn export_portable(
    connection: &Connection,
    cipher: &DataCipher,
) -> Result<(Vec<PortableBotDatabase>, Vec<PortableBotDatabaseRow>), String> {
    let databases = {
        let mut statement = connection
            .prepare(
                "SELECT id, bot_id, name, schema_json, created_at, updated_at
                 FROM bot_databases ORDER BY created_at ASC, id ASC",
            )
            .map_err(error_text)?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                ))
            })
            .map_err(error_text)?;
        let mut result = Vec::new();
        for row in rows {
            let (id, bot_id, name, stored_schema, created_at, updated_at) =
                row.map_err(error_text)?;
            result.push(PortableBotDatabase {
                schema: open_json(cipher, &database_schema_context(&id), &stored_schema)?,
                id,
                bot_id,
                name,
                created_at,
                updated_at,
            });
        }
        result
    };
    let rows = {
        let mut statement = connection
            .prepare(
                "SELECT database_id, table_id, row_id, body_json, created_at, updated_at
                 FROM bot_database_rows
                 ORDER BY database_id ASC, table_id ASC, created_at ASC, row_id ASC",
            )
            .map_err(error_text)?;
        let stored = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                ))
            })
            .map_err(error_text)?;
        let mut result = Vec::new();
        for row in stored {
            let (database_id, table_id, row_id, body, created_at, updated_at) =
                row.map_err(error_text)?;
            result.push(PortableBotDatabaseRow {
                body: open_json(
                    cipher,
                    &database_row_context(&database_id, &table_id, &row_id),
                    &body,
                )?,
                database_id,
                table_id,
                row_id,
                created_at,
                updated_at,
            });
        }
        result
    };
    Ok((databases, rows))
}

pub(crate) fn validate_portable(
    databases: &[PortableBotDatabase],
    rows: &[PortableBotDatabaseRow],
    bot_ids: &HashSet<&str>,
) -> Result<(), String> {
    if databases.len() > bot_ids.len() || databases.len() > 500 {
        return Err("The local table backup has too many bot databases.".into());
    }
    let mut database_ids = HashSet::new();
    let mut database_bot_ids = HashSet::new();
    let mut schemas = HashMap::new();
    for database in databases {
        validate_identifier(&database.id, "archived database")?;
        validate_identifier(&database.bot_id, "archived database bot")?;
        if !bot_ids.contains(database.bot_id.as_str())
            || database.id != format!("bot-database:{}", database.bot_id)
            || !database_ids.insert(database.id.as_str())
            || !database_bot_ids.insert(database.bot_id.as_str())
        {
            return Err("The local table backup has an invalid bot database.".into());
        }
        if database.name != "Local data" {
            return Err("The local table backup has an invalid database label.".into());
        }
        canonical_time(&database.created_at, "archived database creation time")?;
        canonical_time(&database.updated_at, "archived database update time")?;
        let schema: BotDatabaseSchema = serde_json::from_value(database.schema.clone())
            .map_err(|_| "The local table backup has an invalid schema.".to_string())?;
        validate_database_schema(&schema)?;
        schemas.insert(database.id.as_str(), schema);
    }
    let mut row_ids = HashSet::new();
    let mut rows_per_table: HashMap<(&str, &str), i64> = HashMap::new();
    let mut bytes_per_database: HashMap<&str, usize> = HashMap::new();
    for row in rows {
        validate_identifier(&row.database_id, "archived row database")?;
        validate_identifier(&row.table_id, "archived row table")?;
        validate_identifier(&row.row_id, "archived row")?;
        if !row_ids.insert((
            row.database_id.as_str(),
            row.table_id.as_str(),
            row.row_id.as_str(),
        )) {
            return Err("The local table backup repeats a row.".into());
        }
        let schema = schemas
            .get(row.database_id.as_str())
            .ok_or_else(|| "The local table backup references a missing database.".to_string())?;
        let table = schema
            .tables
            .iter()
            .find(|table| table.id == row.table_id)
            .ok_or_else(|| "The local table backup references a missing table.".to_string())?;
        let body = row
            .body
            .as_object()
            .filter(|body| body.len() == 1 && body.contains_key("values"))
            .ok_or_else(|| "The local table backup has an invalid row.".to_string())?;
        if serde_json::to_vec(body).map_err(error_text)?.len() > MAX_ROW_BYTES {
            return Err("The local table backup has an oversized row.".into());
        }
        let values = body
            .get("values")
            .and_then(Value::as_object)
            .cloned()
            .ok_or_else(|| "The local table backup has an invalid row.".to_string())?;
        validate_row_values(&table.columns, values)?;
        canonical_time(&row.created_at, "archived row creation time")?;
        canonical_time(&row.updated_at, "archived row update time")?;
        let count = rows_per_table
            .entry((row.database_id.as_str(), row.table_id.as_str()))
            .or_default();
        *count += 1;
        if *count > MAX_ROWS_PER_TABLE {
            return Err("The local table backup exceeds the per-table row limit.".into());
        }
        *bytes_per_database
            .entry(row.database_id.as_str())
            .or_default() += row.body.to_string().len();
    }
    for database in databases {
        let bytes = database.schema.to_string().len()
            + bytes_per_database
                .get(database.id.as_str())
                .copied()
                .unwrap_or_default();
        if bytes > MAX_BOT_DATABASE_BYTES as usize {
            return Err("The local table backup exceeds the per-bot size limit.".into());
        }
    }
    Ok(())
}

pub(crate) fn restore_portable(
    transaction: &Transaction<'_>,
    cipher: &DataCipher,
    databases: &[PortableBotDatabase],
    rows: &[PortableBotDatabaseRow],
) -> Result<(), String> {
    for database in databases {
        let sealed = cipher.seal(
            &database_schema_context(&database.id),
            &database.schema.to_string(),
        )?;
        transaction
            .execute(
                "INSERT INTO bot_databases
                    (id, bot_id, name, relative_path, schema_json, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    database.id,
                    database.bot_id,
                    database.name,
                    MANAGED_DATABASE_PATH,
                    sealed,
                    database.created_at,
                    database.updated_at,
                ],
            )
            .map_err(error_text)?;
    }
    for row in rows {
        let sealed = cipher.seal(
            &database_row_context(&row.database_id, &row.table_id, &row.row_id),
            &row.body.to_string(),
        )?;
        transaction
            .execute(
                "INSERT INTO bot_database_rows
                    (database_id, table_id, row_id, body_json, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    row.database_id,
                    row.table_id,
                    row.row_id,
                    sealed,
                    row.created_at,
                    row.updated_at,
                ],
            )
            .map_err(error_text)?;
    }
    Ok(())
}

fn table_records(
    connection: &Connection,
    database_id: &str,
    bot_id: &str,
    schema: &BotDatabaseSchema,
) -> Result<Vec<LocalBotTable>, String> {
    let mut result = Vec::with_capacity(schema.tables.len());
    for table in &schema.tables {
        let row_count = connection
            .query_row(
                "SELECT COUNT(*) FROM bot_database_rows WHERE database_id = ?1 AND table_id = ?2",
                params![database_id, table.id],
                |row| row.get(0),
            )
            .map_err(error_text)?;
        result.push(LocalBotTable {
            id: table.id.clone(),
            database_id: database_id.to_string(),
            bot_id: bot_id.to_string(),
            name: table.name.clone(),
            version: table.version,
            columns: table.columns.clone(),
            row_count,
            created_at: table.created_at.clone(),
            updated_at: table.updated_at.clone(),
        });
    }
    result.sort_by(|left, right| {
        right
            .updated_at
            .cmp(&left.updated_at)
            .then_with(|| left.name.cmp(&right.name))
    });
    Ok(result)
}

fn load_database_schema(
    connection: &Connection,
    cipher: &DataCipher,
    bot_id: &str,
) -> Result<Option<(String, BotDatabaseSchema, String, String)>, String> {
    let row = connection
        .query_row(
            "SELECT id, schema_json, created_at, updated_at FROM bot_databases WHERE bot_id = ?1",
            params![bot_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            },
        )
        .optional()
        .map_err(error_text)?;
    open_database_schema(cipher, row)
}

fn load_database_schema_from_transaction(
    transaction: &Transaction<'_>,
    cipher: &DataCipher,
    bot_id: &str,
) -> Result<Option<(String, BotDatabaseSchema, String, String)>, String> {
    let row = transaction
        .query_row(
            "SELECT id, schema_json, created_at, updated_at FROM bot_databases WHERE bot_id = ?1",
            params![bot_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            },
        )
        .optional()
        .map_err(error_text)?;
    open_database_schema(cipher, row)
}

fn open_database_schema(
    cipher: &DataCipher,
    row: Option<(String, String, String, String)>,
) -> Result<Option<(String, BotDatabaseSchema, String, String)>, String> {
    let Some((id, stored_schema, created_at, updated_at)) = row else {
        return Ok(None);
    };
    let plaintext = cipher.open(&database_schema_context(&id), &stored_schema)?;
    let schema: BotDatabaseSchema = serde_json::from_str(&plaintext)
        .map_err(|_| "This bot's local table schema is damaged.".to_string())?;
    validate_database_schema(&schema)?;
    Ok(Some((
        id,
        schema,
        canonical_time(&created_at, "database creation time")?,
        canonical_time(&updated_at, "database update time")?,
    )))
}

fn validate_database_schema(schema: &BotDatabaseSchema) -> Result<(), String> {
    if schema.schema_version != BOT_DATABASE_SCHEMA_VERSION
        || schema.revision < 0
        || schema.revision != schema.migrations.len() as i64
        || schema.tables.len() != schema.migrations.len()
        || schema.tables.len() > MAX_TABLES_PER_BOT
        || schema.migrations.len() > 1_000
    {
        return Err("This bot's local table schema is invalid.".into());
    }
    let mut ids = HashSet::new();
    let mut names = HashSet::new();
    for table in &schema.tables {
        validate_identifier(&table.id, "stored table")?;
        validate_display_name(&table.name, 64, "stored table")?;
        reject_sensitive_label(&table.name)?;
        if table.version < 1
            || !ids.insert(table.id.as_str())
            || !names.insert(table.name.to_lowercase())
        {
            return Err("This bot's local table schema repeats a table.".into());
        }
        validate_columns(table.columns.clone())?;
        canonical_time(&table.created_at, "table creation time")?;
        canonical_time(&table.updated_at, "table update time")?;
    }
    let table_ids = schema
        .tables
        .iter()
        .map(|table| table.id.as_str())
        .collect::<HashSet<_>>();
    let mut migration_versions = HashSet::new();
    let mut migrated_table_ids = HashSet::new();
    for migration in &schema.migrations {
        if migration.version < 1
            || migration.version > schema.revision
            || !migration_versions.insert(migration.version)
            || migration.kind != "create-table"
            || !table_ids.contains(migration.table_id.as_str())
            || !migrated_table_ids.insert(migration.table_id.as_str())
        {
            return Err("This bot's local table migration history is invalid.".into());
        }
        validate_display_name(&migration.summary, 160, "table migration")?;
        canonical_time(&migration.created_at, "table migration time")?;
    }
    Ok(())
}

fn validate_columns(columns: Vec<BotDataColumn>) -> Result<Vec<BotDataColumn>, String> {
    if columns.is_empty() || columns.len() > MAX_COLUMNS_PER_TABLE {
        return Err("A local table needs between 1 and 16 columns.".into());
    }
    let mut names = HashSet::new();
    let mut validated = Vec::with_capacity(columns.len());
    for column in columns {
        let name = validate_display_name(&column.name, 48, "column")?;
        reject_sensitive_label(&name)?;
        if !matches!(
            column.r#type.as_str(),
            "text" | "number" | "boolean" | "date" | "url"
        ) {
            return Err(
                "Local table columns support text, number, boolean, date, or URL values.".into(),
            );
        }
        if !names.insert(name.to_lowercase()) {
            return Err("Local table column names must be unique.".into());
        }
        validated.push(BotDataColumn {
            name,
            r#type: column.r#type,
        });
    }
    Ok(validated)
}

fn validate_row_values(
    columns: &[BotDataColumn],
    values: Map<String, Value>,
) -> Result<Map<String, Value>, String> {
    if values.is_empty() || values.len() > columns.len() {
        return Err("A local table row needs at least one known column.".into());
    }
    let mut canonical = Map::new();
    for (requested_name, value) in values {
        let column = columns
            .iter()
            .find(|column| column.name.eq_ignore_ascii_case(requested_name.trim()))
            .ok_or_else(|| format!("{requested_name} is not a column in this local table."))?;
        if canonical.contains_key(&column.name) {
            return Err("A local table row repeats a column.".into());
        }
        validate_cell(column, &value)?;
        canonical.insert(column.name.clone(), value);
    }
    let complete = columns
        .iter()
        .map(|column| {
            let value = canonical.remove(&column.name).unwrap_or(Value::Null);
            (column.name.clone(), value)
        })
        .collect::<Map<_, _>>();
    if complete.values().all(Value::is_null) {
        return Err("A local table row cannot be empty.".into());
    }
    if serde_json::to_vec(&complete).map_err(error_text)?.len() > MAX_ROW_BYTES {
        return Err("That row is too large for a local table.".into());
    }
    Ok(complete)
}

fn validate_cell(column: &BotDataColumn, value: &Value) -> Result<(), String> {
    if value.is_null() {
        return Ok(());
    }
    match column.r#type.as_str() {
        "text" => {
            let text = value
                .as_str()
                .ok_or_else(|| format!("{} needs text.", column.name))?;
            validate_cell_text(text)?;
        }
        "number" => {
            let number = value
                .as_f64()
                .filter(|number| number.is_finite())
                .ok_or_else(|| format!("{} needs a finite number.", column.name))?;
            let _ = number;
        }
        "boolean" => {
            if !value.is_boolean() {
                return Err(format!("{} needs true or false.", column.name));
            }
        }
        "date" => {
            let text = value
                .as_str()
                .ok_or_else(|| format!("{} needs a date.", column.name))?;
            validate_cell_text(text)?;
            if NaiveDate::parse_from_str(text, "%Y-%m-%d").is_err()
                && DateTime::parse_from_rfc3339(text).is_err()
            {
                return Err(format!(
                    "{} needs YYYY-MM-DD or an ISO date and time.",
                    column.name
                ));
            }
        }
        "url" => {
            let text = value
                .as_str()
                .ok_or_else(|| format!("{} needs an HTTPS URL.", column.name))?;
            validate_cell_text(text)?;
            let parsed = url::Url::parse(text)
                .map_err(|_| format!("{} needs an HTTPS URL.", column.name))?;
            if parsed.scheme() != "https"
                || !parsed.username().is_empty()
                || parsed.password().is_some()
            {
                return Err(format!(
                    "{} needs an HTTPS URL without credentials.",
                    column.name
                ));
            }
        }
        _ => return Err("This local table has an unsupported column type.".into()),
    }
    Ok(())
}

fn validate_cell_text(value: &str) -> Result<(), String> {
    if value.len() > MAX_CELL_CHARS || value.contains('\0') {
        return Err("Local table cells support up to 2,000 characters.".into());
    }
    reject_sensitive_value(value)
}

fn reject_sensitive_label(value: &str) -> Result<(), String> {
    let normalized = value.to_lowercase().replace(['_', '-'], " ");
    if [
        "password",
        "passcode",
        "api key",
        "access token",
        "refresh token",
        "private key",
        "secret key",
        "seed phrase",
        "recovery phrase",
        "one time code",
        "verification code",
        "security code",
        "credit card",
        "card number",
        "social security",
    ]
    .iter()
    .any(|marker| normalized.contains(marker))
    {
        return Err("Local tables cannot be used to store credentials, payment details, or recovery secrets.".into());
    }
    Ok(())
}

fn reject_sensitive_value(value: &str) -> Result<(), String> {
    reject_sensitive_label(value)?;
    if value.to_lowercase().contains("-----begin") {
        return Err("Local tables cannot be used to store credentials, payment details, or recovery secrets.".into());
    }
    Ok(())
}

fn validate_display_name(value: &str, max: usize, label: &str) -> Result<String, String> {
    let name = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if name.is_empty()
        || name.len() > max
        || !name
            .chars()
            .all(|character| character.is_alphanumeric() || matches!(character, ' ' | '-' | '_'))
    {
        return Err(format!(
            "Choose a short {label} name using letters, numbers, spaces, dashes, or underscores."
        ));
    }
    Ok(name)
}

fn validate_identifier(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 180
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b':' | b'_' | b'-'))
    {
        return Err(format!("The {label} identifier is invalid."));
    }
    Ok(())
}

fn canonical_time(value: &str, label: &str) -> Result<String, String> {
    let parsed = DateTime::parse_from_rfc3339(value)
        .map_err(|_| format!("The {label} is invalid."))?
        .with_timezone(&Utc);
    let canonical = parsed.to_rfc3339_opts(SecondsFormat::Millis, true);
    if canonical != value {
        return Err(format!("The {label} is invalid."));
    }
    Ok(canonical)
}

fn require_bot(connection: &Connection, bot_id: &str) -> Result<(), String> {
    let exists: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM bots WHERE id = ?1)",
            params![bot_id],
            |row| row.get(0),
        )
        .map_err(error_text)?;
    if !exists {
        return Err("That bot is no longer available on this Mac.".into());
    }
    Ok(())
}

fn enforce_database_size(
    transaction: &Transaction<'_>,
    database_id: &str,
    schema_bytes: i64,
    added_row_bytes: i64,
) -> Result<(), String> {
    let row_bytes: i64 = transaction
        .query_row(
            "SELECT COALESCE(SUM(LENGTH(body_json)), 0) FROM bot_database_rows WHERE database_id = ?1",
            params![database_id],
            |row| row.get(0),
        )
        .map_err(error_text)?;
    if schema_bytes + row_bytes + added_row_bytes > MAX_BOT_DATABASE_BYTES {
        return Err(
            "This bot's local data has reached its 8 MB limit. Export a table before adding more."
                .into(),
        );
    }
    Ok(())
}

fn record_data_event(
    transaction: &Transaction<'_>,
    cipher: &DataCipher,
    bot_id: &str,
    event_type: &str,
    body: Value,
    created_at: &str,
) -> Result<(), String> {
    let event_id = format!("event-{bot_id}-data-{}", Utc::now().timestamp_micros());
    let sealed = cipher.seal(&format!("bot-events:{event_id}"), &body.to_string())?;
    transaction
        .execute(
            "INSERT INTO bot_events (id, bot_id, event_type, body_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![event_id, bot_id, event_type, sealed, created_at],
        )
        .map_err(error_text)?;
    Ok(())
}

fn database_schema_context(database_id: &str) -> String {
    format!("bot-databases:{database_id}:schema")
}

fn database_row_context(database_id: &str, table_id: &str, row_id: &str) -> String {
    format!("bot-databases:{database_id}:{table_id}:{row_id}")
}

fn open_json(cipher: &DataCipher, context: &str, stored: &str) -> Result<Value, String> {
    let plaintext = cipher.open(context, stored)?;
    serde_json::from_str(&plaintext).map_err(error_text)
}

fn display_cell(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(value)) => value.clone(),
        Some(Value::Number(value)) => value.to_string(),
        Some(Value::Bool(value)) => value.to_string(),
        _ => String::new(),
    }
}

fn csv_cell(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

fn canonical_now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn error_text(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::DataCipher;
    use tempfile::tempdir;

    fn state() -> (tempfile::TempDir, AppState) {
        let directory = tempdir().expect("temporary database");
        let state = AppState::for_test(directory.path()).expect("test state");
        (directory, state)
    }

    fn create_request(bot_id: &str, table_id: &str) -> CreateLocalBotTableRequest {
        CreateLocalBotTableRequest {
            id: table_id.into(),
            bot_id: bot_id.into(),
            name: "Page observations".into(),
            columns: vec![
                BotDataColumn {
                    name: "URL".into(),
                    r#type: "url".into(),
                },
                BotDataColumn {
                    name: "Changed".into(),
                    r#type: "boolean".into(),
                },
                BotDataColumn {
                    name: "Summary".into(),
                    r#type: "text".into(),
                },
            ],
            created_at: "2026-08-19T12:00:00.000Z".into(),
        }
    }

    #[test]
    fn bot_tables_are_typed_encrypted_isolated_and_bounded() {
        let (_directory, state) = state();
        let created = create_local_bot_table(&state, create_request("bot-codelit", "table-pages"))
            .expect("created table");
        assert_eq!(created.table.name, "Page observations");
        assert!(created.rows.is_empty());

        let added = append_local_bot_table_row(
            &state,
            AppendLocalBotTableRowRequest {
                id: "row-page-1".into(),
                bot_id: "bot-codelit".into(),
                table_id: "table-pages".into(),
                values: serde_json::from_value(json!({
                    "URL": "https://codelit.io/pricing",
                    "Changed": true,
                    "Summary": "Pricing changed after the release"
                }))
                .expect("values"),
                created_at: "2026-08-19T12:01:00.000Z".into(),
            },
        )
        .expect("added row");
        assert_eq!(added.total_rows, 1);
        assert_eq!(added.rows[0].values["Changed"], true);
        assert!(open_local_bot_table(&state, "missing-bot", "table-pages", 100).is_err());
        crate::storage::create_local_bot(
            &state,
            crate::storage::CreateLocalBotRequest {
                id: "bot-private".into(),
                name: "Private Bot".into(),
                job: "Keep a separate local workspace.".into(),
                avatar: None,
                created_at: "2026-08-19T12:01:30.000Z".into(),
            },
        )
        .expect("second bot");
        assert!(
            list_local_bot_tables(&state, "bot-private")
                .expect("second bot tables")
                .is_empty()
        );

        let connection = state.connection().expect("connection");
        let stored_schema: String = connection
            .query_row("SELECT schema_json FROM bot_databases", [], |row| {
                row.get(0)
            })
            .expect("stored schema");
        let stored_row: String = connection
            .query_row("SELECT body_json FROM bot_database_rows", [], |row| {
                row.get(0)
            })
            .expect("stored row");
        assert!(DataCipher::is_sealed(&stored_schema));
        assert!(DataCipher::is_sealed(&stored_row));
        assert!(!stored_schema.contains("Page observations"));
        assert!(!stored_row.contains("Pricing changed"));

        let invalid = append_local_bot_table_row(
            &state,
            AppendLocalBotTableRowRequest {
                id: "row-secret".into(),
                bot_id: "bot-codelit".into(),
                table_id: "table-pages".into(),
                values: serde_json::from_value(json!({ "Summary": "API key is secret-value" }))
                    .expect("values"),
                created_at: "2026-08-19T12:02:00.000Z".into(),
            },
        )
        .expect_err("secret rejected");
        assert!(invalid.contains("credentials"));
    }

    #[test]
    fn csv_export_uses_schema_order_and_escapes_cells() {
        let (_directory, state) = state();
        create_local_bot_table(&state, create_request("bot-codelit", "table-pages"))
            .expect("created table");
        append_local_bot_table_row(
            &state,
            AppendLocalBotTableRowRequest {
                id: "row-page-1".into(),
                bot_id: "bot-codelit".into(),
                table_id: "table-pages".into(),
                values: serde_json::from_value(json!({
                    "URL": "https://codelit.io",
                    "Changed": false,
                    "Summary": "Same, with \"proof\""
                }))
                .expect("values"),
                created_at: "2026-08-19T12:01:00.000Z".into(),
            },
        )
        .expect("added row");
        let export =
            export_local_bot_table_csv(&state, "bot-codelit", "table-pages").expect("CSV export");
        assert_eq!(export.file_name, "page-observations.csv");
        assert!(export.data.starts_with("\"URL\",\"Changed\",\"Summary\"\n"));
        assert!(export.data.contains("\"Same, with \"\"proof\"\"\""));
    }
}
