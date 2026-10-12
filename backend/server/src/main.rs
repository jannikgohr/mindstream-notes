use clap::{Parser, Subcommand};
use mindstream_server::{serve, AppState, Config};

#[derive(Parser)]
#[command(name = "mindstream-server", version, about)]
struct Cli {
    #[command(flatten)]
    config: Config,

    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// Run the server. This is the default.
    Serve,
    /// Ask the server on this machine whether it is up. Exits non-zero when
    /// it is not, for a container health check that has no curl to call.
    Healthcheck,
}

/// One plain HTTP request to the health route of the server on this machine.
async fn healthcheck(listen: &str) -> Result<(), Box<dyn std::error::Error>> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let port = listen.rsplit(':').next().unwrap_or("3735");
    let mut stream = tokio::net::TcpStream::connect(format!("127.0.0.1:{port}")).await?;
    stream
        .write_all(b"GET /healthz HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
        .await?;
    let mut response = String::new();
    stream.read_to_string(&mut response).await?;
    if response.starts_with("HTTP/1.1 200") {
        Ok(())
    } else {
        Err(format!(
            "unexpected answer: {}",
            response.lines().next().unwrap_or("")
        )
        .into())
    }
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "mindstream_server=info,tower_http=warn".into()),
        )
        .init();

    let cli = Cli::parse();
    match cli.command.unwrap_or(Command::Serve) {
        Command::Healthcheck => healthcheck(&cli.config.listen).await?,
        Command::Serve => {
            let listen = cli.config.listen.clone();
            if cli.config.test_reset {
                tracing::warn!("the account reset route is on; never run a real server this way");
            }
            let state = AppState::connect(cli.config).await?;
            let listener = tokio::net::TcpListener::bind(&listen).await?;
            tracing::info!("listening on {}", listener.local_addr()?);
            serve(listener, state, shutdown_signal()).await?;
        }
    }
    Ok(())
}
