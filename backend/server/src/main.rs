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
