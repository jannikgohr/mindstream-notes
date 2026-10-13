//! Unit tests for the sync loop, grouped to mirror the modules they cover.

use super::collab_room::*;
use super::*;
use crate::db::open_memory_for_tests;

mod apply_assets;
mod apply_folders;
mod apply_notes;
mod changes;
mod claim;
mod collab_room;
mod collections;
mod feed;
mod fixtures;
