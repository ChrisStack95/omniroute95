-- #13575: let a scope's proxy pool re-evaluate its member on every request.
--
-- The per-connection cache in resolveProxyForConnection freezes whichever pool
-- member the rotation strategy picked first. A per-scope opt-in flag, stored
-- next to the strategy and the sticky window, lets a pool answer again on each
-- chat-path request instead. Off (0) by default: existing pools keep today's
-- stable member per connection; only scopes whose operator enables the flag
-- change behavior.
ALTER TABLE proxy_scope_rotation ADD COLUMN reevaluate_per_request INTEGER NOT NULL DEFAULT 0;
