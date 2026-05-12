package com.jannikgohr.mindstream_notes

import android.os.Bundle
import androidx.activity.enableEdgeToEdge
import io.crates.keyring.Keyring

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    // Initialise the NDK context BEFORE delegating to super.onCreate:
    // TauriActivity boots the Rust runtime during super.onCreate, which
    // in turn runs lib.rs::init_keyring → android_native_keyring_store
    // ::Store::new(). That call panics if ndk-context isn't populated.
    Keyring.initializeNdkContext(this.applicationContext)
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }
}
