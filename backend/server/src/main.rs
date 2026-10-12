use clap::{Parser, Subcommand};
use mindstream_server::limits::Entitlements;
use mindstream_server::{admin, serve, AppState, Config};

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
    /// Look at and manage accounts.
    User {
        #[command(subcommand)]
        command: UserCommand,
    },
    /// Manage the codes that let someone sign up where signup is not open.
    SignupCode {
        #[command(subcommand)]
        command: SignupCodeCommand,
    },
}

#[derive(Subcommand)]
enum SignupCodeCommand {
    /// Make a code for one signup. It is printed once and cannot be shown
    /// again.
    Create {
        /// Days until the code stops working.
        #[arg(long, default_value_t = 7)]
        days: i32,
        /// Who it is for. Shown in the list, never to the person signing up.
        #[arg(long, default_value = "")]
        note: String,
    },
    /// List the codes made so far and what became of them.
    List,
    /// Withdraw a code that has not been used. Takes the number from the
    /// list.
    Revoke { id: i64 },
}

#[derive(Subcommand)]
enum UserCommand {
    /// List every account with its session count and stored bytes.
    List,
    /// Switch an account off and end its sessions. Its data is kept.
    Disable { username: String },
    /// Switch a disabled account back on.
    Enable { username: String },
    /// Delete an account and every collection it owns. Cannot be undone.
    Delete { username: String },
    /// Show what an account uses and what its plan allows.
    Usage { username: String },
    /// Set what an account's plan allows. A limit left out is not applied.
    /// Lowering a limit below current use removes nothing; it stops the
    /// account from adding more.
    Limit {
        username: String,
        /// A name for the plan, shown to the user.
        #[arg(long, default_value = "custom")]
        plan: String,
        /// Storage across everything the account owns, in MiB.
        #[arg(long)]
        storage_mib: Option<i64>,
        /// Collections the account may own.
        #[arg(long)]
        max_spaces: Option<i32>,
        /// Members one of its collections may have, the owner included.
        #[arg(long)]
        max_members: Option<i32>,
        /// Content of a single item, in MiB.
        #[arg(long)]
        max_item_mib: Option<i64>,
        /// Accept nothing new. Reading and deleting keep working.
        #[arg(long)]
        read_only: bool,
    },
    /// Lift every limit from an account.
    Unlimit { username: String },
    /// Remove an account's authenticator and backup codes, for an owner who
    /// has lost both. Signing in then takes the password alone.
    #[command(name = "reset-2fa")]
    ResetSecondFactor { username: String },
}

const MIB: i64 = 1024 * 1024;

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

fn limit<T: std::fmt::Display>(value: Option<T>) -> String {
    value.map_or_else(|| "no limit".to_owned(), |value| value.to_string())
}

async fn manage_users(
    state: &AppState,
    command: UserCommand,
) -> Result<(), Box<dyn std::error::Error>> {
    let (username, found, done) = match command {
        UserCommand::List => {
            let accounts = admin::list_accounts(state).await?;
            println!(
                "{:<32} {:<36} {:>8} {:>14}  {:<4} state",
                "username", "email", "sessions", "bytes", "2fa"
            );
            for account in &accounts {
                println!(
                    "{:<32} {:<36} {:>8} {:>14}  {:<4} {}",
                    account.username,
                    account.email,
                    account.sessions,
                    account.bytes_used,
                    if account.second_factor { "on" } else { "off" },
                    if account.disabled {
                        "disabled"
                    } else {
                        "active"
                    }
                );
            }
            println!("{} account(s)", accounts.len());
            return Ok(());
        }
        UserCommand::Usage { username } => {
            let Some(usage) = admin::usage(state, &username).await? else {
                return Err(format!("no account named {username}").into());
            };
            let plan = &usage.entitlements;
            if !usage.limited {
                println!("{username} has no limits");
            } else {
                println!(
                    "plan            {}{}",
                    plan.plan,
                    if plan.read_only { " (read-only)" } else { "" }
                );
            }
            println!(
                "storage         {} of {} bytes",
                usage.storage_used_bytes,
                limit(plan.storage_limit_bytes)
            );
            println!(
                "collections     {} of {}",
                usage.spaces,
                limit(plan.max_spaces)
            );
            println!("members each    {}", limit(plan.max_members_per_space));
            println!("largest item    {} bytes", limit(plan.max_item_bytes));
            return Ok(());
        }
        UserCommand::Disable { username } => {
            let found = admin::set_disabled(state, &username, true).await?;
            (username, found, "disabled")
        }
        UserCommand::Enable { username } => {
            let found = admin::set_disabled(state, &username, false).await?;
            (username, found, "enabled")
        }
        UserCommand::Delete { username } => {
            let found = admin::delete_account(state, &username).await?;
            (username, found, "deleted")
        }
        UserCommand::Limit {
            username,
            plan,
            storage_mib,
            max_spaces,
            max_members,
            max_item_mib,
            read_only,
        } => {
            let entitlements = Entitlements {
                plan,
                storage_limit_bytes: storage_mib.map(|mib| mib * MIB),
                max_spaces,
                max_members_per_space: max_members,
                max_item_bytes: max_item_mib.map(|mib| mib * MIB),
                read_only,
            };
            let found = admin::set_entitlements(state, &username, Some(&entitlements)).await?;
            (username, found, "limited")
        }
        UserCommand::Unlimit { username } => {
            let found = admin::set_entitlements(state, &username, None).await?;
            (username, found, "freed of limits")
        }
        UserCommand::ResetSecondFactor { username } => {
            let found = admin::reset_second_factor(state, &username).await?;
            (username, found, "no longer needs a code to sign in")
        }
    };
    if !found {
        return Err(format!("no account named {username}").into());
    }
    println!("{username} {done}");
    Ok(())
}

async fn manage_signup_codes(
    state: &AppState,
    command: SignupCodeCommand,
) -> Result<(), Box<dyn std::error::Error>> {
    match command {
        SignupCodeCommand::Create { days, note } => {
            if !(1..=365).contains(&days) {
                return Err("a code lasts between 1 and 365 days".into());
            }
            let code = admin::create_signup_code(state, &note, days).await?;
            println!("{code}");
            println!("Good for one signup in the next {days} day(s). It is not shown again.");
        }
        SignupCodeCommand::List => {
            let codes = admin::list_signup_codes(state).await?;
            println!("{:>5}  {:<10}  {:<24} note", "id", "expires", "state");
            for code in &codes {
                let state = match (&code.used_by, code.used, code.expired) {
                    (Some(username), _, _) => format!("used by {username}"),
                    (None, true, _) => "used".to_owned(),
                    (None, false, true) => "expired".to_owned(),
                    (None, false, false) => "open".to_owned(),
                };
                println!(
                    "{:>5}  {:<10}  {:<24} {}",
                    code.id, code.expires, state, code.note
                );
            }
            println!("{} code(s)", codes.len());
        }
        SignupCodeCommand::Revoke { id } => {
            if !admin::revoke_signup_code(state, id).await? {
                return Err(format!("no unused code with id {id}").into());
            }
            println!("code {id} withdrawn");
        }
    }
    Ok(())
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
        Command::User { command } => {
            let state = AppState::connect(cli.config).await?;
            manage_users(&state, command).await?;
        }
        Command::SignupCode { command } => {
            let state = AppState::connect(cli.config).await?;
            manage_signup_codes(&state, command).await?;
        }
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
