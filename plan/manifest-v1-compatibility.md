# Plugin Manifest v1

## Required fields

| Field | Shape | Rule |
|---|---|---|
| `id` | string | `^[a-z][a-z0-9-]{1,63}$` |
| `name` | non-empty string | User-visible name |
| `version` | `major.minor.patch` | Complete semver |
| `entry` | relative path | Must remain inside the plugin directory and exist |

## Optional fields

`enabled` defaults to `true`; `lazy` defaults to `false`; `requires` is an array of plugin ids; `essential` prevents complete uninstall; `provides` declares service keys; `nav` declares a frontend contribution; `limits` controls lifecycle timeout and circuit breaker; `cleanup` is `keep`, `archive`, or `purge`.

### API compatibility

```json
{
  "compatibility": {
    "api": { "min": "1.0.0", "max": "1.0.0" }
  }
}
```

`min` and `max` are optional complete semver values. `min` cannot exceed `max`, and the host API `1.0.0` must fall inside the declared range. Omitting `compatibility` keeps the legacy trusted compatibility path.

### Capability permissions

```json
{
  "permissions": {
    "capabilities": {
      "tool": ["example_hello"],
      "service": ["example"]
    }
  }
}
```

Once `permissions.capabilities` is declared, every registered capability type and name must be listed. Omitting `permissions` preserves legacy trusted loading for existing local plugins.

### Configuration schema

`config` uses the shared JSON Schema subset: `type`, `properties`, `required`, `items`, `enum`, `minimum`, `maximum`, `minLength`, and `maxLength`. The current `config.<plugin-id>` values are validated before `onLoad`; invalid configuration rejects the new version and triggers the loader rollback path during reload.

## Compatibility matrix

| Plugin manifest | Host API 1.0.0 | Permission behavior | Migration action |
|---|---|---|---|
| No `compatibility` or `permissions` | Loads | Legacy trusted mode | Keep working; add declarations before distribution |
| `compatibility.api` contains 1.0.0 | Loads | As declared | No code change required |
| `compatibility.api` excludes 1.0.0 | Rejects before `onLoad` | No capability is registered | Raise `min`/`max` or pin the plugin to a compatible host |
| `permissions.capabilities` lists all registrations | Loads | Only listed names/types allowed | Update the list when adding a capability |
| Permission declaration omits a registration | Rejects during registration | Effects are rolled back and a denial audit event is emitted | Add the exact capability name/type |
| `config` values satisfy the schema | Loads | Configuration is available to the plugin | No action |
| `config` values violate the schema | Rejects before `onLoad` | Reload keeps the previous version when rollback succeeds | Fix configuration or schema |

## Migration and rollback

1. Copy the existing plugin directory and record its current `plugin.json` and dependency lock before editing.
2. Add `compatibility.api` with the host API range, then run `npm run plugin:validate -- <plugin-dir>`.
3. Add `permissions.capabilities` only after listing every capability currently registered by the plugin; use the generated scaffold as the baseline.
4. Add `config` only when the plugin needs machine-validated settings, and test both a valid and invalid configuration.
5. Reload the plugin and verify its state and visible capabilities. A failed reload restores the previous loaded version; a failed first load leaves no registered effects.

The scaffold command refuses to overwrite an existing directory. To roll back a manifest migration, restore the recorded directory and manifest snapshot, then reload the plugin. Removing newly added optional fields is backward-compatible with the legacy trusted path.

## Verification

- `kernel/tests/loader.spec.ts`: API compatibility, malformed ranges, configuration schema, permission allow/deny, rollback and legacy compatibility.
- `scripts/plugin-scaffold.spec.mjs`: manifest shape, path safety, API compatibility and permission validation.
- `npm run typecheck`
- `npm run plugin:validate -- <plugin-dir>`
