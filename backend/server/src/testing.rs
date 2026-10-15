//! Database access for unit tests that need the real thing.
//!
//! Uses the same database as the integration tests: the one `compose.dev.yml`
//! starts, or whatever `MINDSTREAM_TEST_DATABASE_URL` names.

use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;

pub async fn pool() -> PgPool {
    let url = std::env::var("MINDSTREAM_TEST_DATABASE_URL").unwrap_or_else(|_| {
        "postgres://mindstream:mindstream@127.0.0.1:15432/mindstream".to_owned()
    });
    let pool = PgPoolOptions::new()
        .max_connections(4)
        .connect(&url)
        .await
        .unwrap_or_else(|err| {
            panic!(
                "these tests need Postgres ({err}). Run `docker compose -f                  backend/server/compose.dev.yml up -d`, or set MINDSTREAM_TEST_DATABASE_URL."
            )
        });
    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .expect("migrations");
    pool
}
