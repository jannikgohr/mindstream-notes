//! Unit tests for the sync loop, grouped to mirror the modules they cover.

use super::collab_room::*;
use super::*;
use crate::db::open_memory_for_tests;
use p256::pkcs8::DecodePrivateKey;

mod apply_folders;
mod apply_notes;
mod collab_room;
mod collections;
mod fixtures;
