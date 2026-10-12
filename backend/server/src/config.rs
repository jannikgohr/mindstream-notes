//! Server configuration, read from flags or `MINDSTREAM_*` variables.

use std::path::PathBuf;

use clap::{Args, ValueEnum};

/// Who may create an account.
#[derive(Clone, Copy, Debug, PartialEq, Eq, ValueEnum)]
pub enum SignupPolicy {
    /// Nobody. Accounts come from an administrator.
    Closed,
    /// Anyone who can reach the server.
    Open,
}

#[derive(Args, Clone, Debug)]
pub struct Config {
    /// Postgres connection string.
    #[arg(long, env = "MINDSTREAM_DATABASE_URL")]
    pub database_url: String,

    /// Address to listen on. TLS is the reverse proxy's job.
    #[arg(long, env = "MINDSTREAM_LISTEN", default_value = "0.0.0.0:3735")]
    pub listen: String,

    /// Directory for chunks too large to keep in the database.
    #[arg(long, env = "MINDSTREAM_BLOB_DIR", default_value = "data/blobs")]
    pub blob_dir: PathBuf,

    /// Who may sign up.
    #[arg(long, env = "MINDSTREAM_SIGNUP", value_enum, default_value = "closed")]
    pub signup: SignupPolicy,

    /// Hostnames clients reach this server by. A login names the host it was
    /// made for, and the server refuses one made for somewhere else. Leave
    /// empty to accept whatever the request's Host header says, which is
    /// right when the reverse proxy passes that header through.
    #[arg(long, env = "MINDSTREAM_PUBLIC_HOSTS", value_delimiter = ',')]
    pub public_hosts: Vec<String>,

    /// Largest request body accepted, in bytes.
    #[arg(long, env = "MINDSTREAM_MAX_BODY_BYTES", default_value_t = 75 * 1024 * 1024)]
    pub max_body_bytes: usize,

    /// Chunks up to this size are stored in the database; larger ones go to
    /// the blob directory. A note is nearly always a single chunk under the
    /// default.
    #[arg(long, env = "MINDSTREAM_INLINE_CHUNK_BYTES", default_value_t = 20 * 1024)]
    pub inline_chunk_bytes: usize,

    /// Connections kept to Postgres.
    #[arg(long, env = "MINDSTREAM_DATABASE_CONNECTIONS", default_value_t = 16)]
    pub database_connections: u32,

    /// Serve the route that wipes and recreates an account. For the client
    /// library's integration tests only; never enable it on a real server.
    #[arg(long, env = "MINDSTREAM_TEST_RESET", default_value_t = false)]
    pub test_reset: bool,
}

impl Config {
    /// Settings for a server started inside a test.
    pub fn for_tests(database_url: String, blob_dir: PathBuf) -> Self {
        Self {
            database_url,
            listen: "127.0.0.1:0".into(),
            blob_dir,
            signup: SignupPolicy::Open,
            public_hosts: Vec::new(),
            max_body_bytes: 75 * 1024 * 1024,
            inline_chunk_bytes: 20 * 1024,
            database_connections: 4,
            test_reset: true,
        }
    }
}
