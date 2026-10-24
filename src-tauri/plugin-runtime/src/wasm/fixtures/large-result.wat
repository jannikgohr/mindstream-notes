;; Returns JSON after a host call, so import and return budgets must differ.
;; Tests substitute OUTPUT_BYTES, OUTPUT_PAGES, OUTPUT_LAST and ENCODING.
(component
  (import "mindstream:plugin/runtime@0.1.0" (instance $runtime
    (export "has-permission" (func (param "permission" string) (result bool)))))
  (core module $memory
    (memory (export "memory") OUTPUT_PAGES)
    (func (export "realloc") (param i32 i32 i32 i32) (result i32) (i32.const 1024))
    (data (i32.const 128) "notes.read"))
  (core instance $memory-instance (instantiate $memory))
  (alias core export $memory-instance "memory" (core memory $memory))
  (alias core export $memory-instance "realloc" (core func $realloc))
  (alias export $runtime "has-permission" (func $has-permission))
  (core func $has-permission (canon lower (func $has-permission)
    (memory $memory) (realloc $realloc)))
  (core module $guest
    (import "host" "has-permission" (func $has-permission (param i32 i32) (result i32)))
    (import "memory" "memory" (memory OUTPUT_PAGES))
    (func (export "invoke") (param i32 i32 i32 i32) (result i32)
      (local $filled i32) (local $chunk i32)
      (drop (call $has-permission (i32.const 128) (i32.const 10)))
      ;; JSON whitespace followed by 0 avoids allocating a second large value
      ;; in the host's JSON parser. UTF-16 whitespace uses 0x20, 0x00 pairs.
      (i32.store16 (i32.const 65536) (i32.const FILL))
      (local.set $filled (i32.const 2))
      (loop $fill
        (local.set $chunk (local.get $filled))
        (if (i32.gt_u (local.get $chunk) (i32.sub (i32.const OUTPUT_BYTES) (local.get $filled)))
          (then (local.set $chunk (i32.sub (i32.const OUTPUT_BYTES) (local.get $filled)))))
        (memory.copy (i32.add (i32.const 65536) (local.get $filled))
          (i32.const 65536) (local.get $chunk))
        (local.set $filled (i32.add (local.get $filled) (local.get $chunk)))
        (br_if $fill (i32.lt_u (local.get $filled) (i32.const OUTPUT_BYTES))))
      (i32.store8 (i32.const OUTPUT_LAST) (i32.const 48))
      (i32.store (i32.const 0) (i32.const 0))
      (i32.store (i32.const 4) (i32.const 65536))
      (i32.store (i32.const 8) (i32.const OUTPUT_LENGTH))
      (i32.const 0)))
  (core instance $host (export "has-permission" (func $has-permission)))
  (core instance $guest-instance (instantiate $guest
    (with "host" (instance $host)) (with "memory" (instance $memory-instance))))
  (type $result (result string (error string)))
  (type $invoke (func (param "export" string) (param "input" string) (result $result)))
  (func (export "invoke") (type $invoke)
    (canon lift (core func $guest-instance "invoke")
      (memory $memory) (realloc $realloc) ENCODING)))
