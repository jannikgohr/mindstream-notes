## Dependencies

Install OpenSSL libraries or the `perl` build system 
to build/link openssl crypto dependencies

## Building

Build command
```shell
pnpm tauri build
```

Build command Linux (for AppImage)
```shell
NO_STRIP=true ARCH=x86_64 pnpm tauri build
```
## Installation
If you're on a minimal setup, install and enable some Secret Service
like `gnome-keyring` or run `KeePassXC` with Secret Service enabled.