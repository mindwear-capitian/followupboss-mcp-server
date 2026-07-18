#!/usr/bin/env bash
# Bet-your-life HTTP integration tests for v1.3.0.
# Tests both bearer auth and full OAuth 2.1 flow against real FUB account.
# Only READ-ONLY operations + one notes create+delete roundtrip.
#
# Required env: FUB_API_KEY
# Optional env: TEST_HOST (default: localhost), TEST_PORT (default: 3999)

set -u
PASS=0
FAIL=0
HOST="${TEST_HOST:-localhost}"
PORT="${TEST_PORT:-3999}"
BASE="http://$HOST:$PORT"

ok()  { PASS=$((PASS+1)); echo "  PASS  $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL  $1"; }

# --- Section 1: Bearer auth mode -------------------------------------------
echo "===== Section 1: Bearer auth mode ====="
BEARER="test-bearer-$(date +%s)"
MCP_TRANSPORT=http PORT=$PORT MCP_BEARER_TOKEN="$BEARER" FUB_API_KEY="$FUB_API_KEY" FUB_SAFE_MODE=true node index.js > /tmp/mcp-bearer.log 2>&1 &
SERVER_PID=$!
sleep 2

# 1.1 Health endpoint
RESP=$(curl -fsS -m 5 "$BASE/health")
if echo "$RESP" | grep -q '"authMode":"bearer"'; then
  ok "health endpoint returns authMode=bearer"
else
  bad "health: $RESP"
fi

# 1.2 OAuth discovery still exists even in bearer mode (clients may probe)
HTTP=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/.well-known/oauth-authorization-server")
[ "$HTTP" = "200" ] && ok "oauth-authorization-server returns 200" || bad "oauth-authorization-server: HTTP $HTTP"

HTTP=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/.well-known/oauth-protected-resource")
[ "$HTTP" = "200" ] && ok "oauth-protected-resource returns 200" || bad "oauth-protected-resource: HTTP $HTTP"

# 1.3 Bearer auth gate
HTTP=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/mcp" -H "Content-Type: application/json" -d '{}')
[ "$HTTP" = "401" ] && ok "POST /mcp without auth = 401" || bad "no-auth POST: HTTP $HTTP"

HTTP=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/mcp" -H "Authorization: Bearer wrong" -H "Content-Type: application/json" -d '{}')
[ "$HTTP" = "401" ] && ok "POST /mcp wrong bearer = 401" || bad "wrong-bearer POST: HTTP $HTTP"

# 1.4 Initialize handshake
INIT_RESP=$(curl -s -X POST "$BASE/mcp" \
  -H "Authorization: Bearer $BEARER" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -D /tmp/init-headers.txt \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"bet-your-life","version":"1"}}}')
SESSION=$(grep -i "mcp-session-id" /tmp/init-headers.txt | head -1 | awk '{print $2}' | tr -d '\r')
if echo "$INIT_RESP" | grep -q '"serverInfo"'; then
  ok "initialize returned serverInfo (session: ${SESSION:0:8}...)"
else
  bad "initialize: $(echo "$INIT_RESP" | head -c 200)"
fi

# 1.5 tools/list returns 137 (safe mode)
TOOLS_RESP=$(curl -s -X POST "$BASE/mcp" \
  -H "Authorization: Bearer $BEARER" -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" -H "Mcp-Session-Id: $SESSION" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}')
TOOL_COUNT=$(echo "$TOOLS_RESP" | grep -oE '"name":"[a-zA-Z]+"' | wc -l | tr -d ' ')
if [ "$TOOL_COUNT" = "137" ]; then
  ok "tools/list returned 137 tools (safe mode)"
else
  bad "tools/list: expected 137, got $TOOL_COUNT"
fi

# 1.6 Call several read-only tools — coverage across domains
call_tool() {
  local label="$1" name="$2" args="$3" check="$4"
  local resp
  resp=$(curl -s -X POST "$BASE/mcp" \
    -H "Authorization: Bearer $BEARER" -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" -H "Mcp-Session-Id: $SESSION" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":$RANDOM,\"method\":\"tools/call\",\"params\":{\"name\":\"$name\",\"arguments\":$args}}")
  # SSE wraps JSON-stringified content with escaped quotes (\"key\":).
  # Match the escaped form to handle nested-text payloads.
  if echo "$resp" | grep -q "\\\\\"$check\\\\\"" || echo "$resp" | grep -q "\"$check\""; then
    ok "tools/call $name $label"
  else
    bad "tools/call $name $label: $(echo "$resp" | head -c 200)"
  fi
}

call_tool "(identity)"      "getIdentity"          '{}'                  'account'
call_tool "(people)"        "listPeople"           '{"limit":1}'         'people'
call_tool "(deals)"         "listDeals"            '{"limit":1}'         'deals'
call_tool "(notes)"         "listNotes"            '{"limit":1}'         'notes'
call_tool "(smartLists)"    "listSmartLists"       '{}'                  'smartLists'
call_tool "(customFields)"  "listCustomFields"     '{}'                  'customFields'
call_tool "(stages)"        "listStages"           '{}'                  'stages'
call_tool "(pipelines)"     "listPipelines"        '{}'                  'pipelines'
call_tool "(tasks)"         "listTasks"            '{"limit":1}'         'tasks'
call_tool "(events)"        "listEvents"           '{"limit":1}'         'events'
call_tool "(users)"         "listUsers"            '{}'                  'users'
call_tool "(appointmentTypes)" "listAppointmentTypes" '{}'               'appointmentTypes'

# 1.7 Safe mode rejects delete tools (deleteNote should be in inactive list)
RESP=$(curl -s -X POST "$BASE/mcp" \
  -H "Authorization: Bearer $BEARER" -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" -H "Mcp-Session-Id: $SESSION" \
  -d '{"jsonrpc":"2.0","id":99,"method":"tools/call","params":{"name":"deleteNote","arguments":{"id":1}}}')
if echo "$RESP" | grep -q "Safe Mode"; then
  ok "SAFE MODE rejects deleteNote with friendly error"
else
  bad "SAFE MODE: $(echo "$RESP" | head -c 200)"
fi

# 1.8 Notes roundtrip — write to FUB and clean up
# Note: SSE responses wrap FUB JSON in an escaped string. Parse the ESCAPED inner
# id (\"id\": N) — NOT the outer JSON-RPC envelope id.
PEOPLE_RESP=$(curl -s -X POST "$BASE/mcp" \
  -H "Authorization: Bearer $BEARER" -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" -H "Mcp-Session-Id: $SESSION" \
  -d '{"jsonrpc":"2.0","id":100,"method":"tools/call","params":{"name":"listPeople","arguments":{"limit":1}}}')
TEST_PID=$(echo "$PEOPLE_RESP" | grep -oE '\\"id\\": *[0-9]+' | head -1 | grep -oE '[0-9]+')
if [ -z "$TEST_PID" ]; then bad "could not parse test person id from listPeople"; TEST_PID=0; fi

NOTE_RESP=$(curl -s -X POST "$BASE/mcp" \
  -H "Authorization: Bearer $BEARER" -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" -H "Mcp-Session-Id: $SESSION" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":101,\"method\":\"tools/call\",\"params\":{\"name\":\"createNote\",\"arguments\":{\"personId\":$TEST_PID,\"body\":\"HTTP INTEGRATION TEST $(date +%s) (auto-delete)\"}}}")
# Extract real FUB note id from escaped inner content
NOTE_ID=$(echo "$NOTE_RESP" | grep -oE '\\"id\\": *[0-9]+' | head -1 | grep -oE '[0-9]+')
if [ -n "$NOTE_ID" ]; then
  ok "createNote over HTTP wrote note id=$NOTE_ID on person $TEST_PID"
  # Verify by reading back via FUB API
  VERIFY=$(curl -s -u "$FUB_API_KEY:" "https://api.followupboss.com/v1/notes/$NOTE_ID")
  if echo "$VERIFY" | grep -q "HTTP INTEGRATION TEST"; then
    ok "verified note $NOTE_ID exists in FUB with correct body"
  else
    bad "verification: $(echo "$VERIFY" | head -c 200)"
  fi
  # Clean up
  CLEAN_HTTP=$(curl -s -o /dev/null -w '%{http_code}' -u "$FUB_API_KEY:" -X DELETE "https://api.followupboss.com/v1/notes/$NOTE_ID")
  if [ "$CLEAN_HTTP" = "200" ] || [ "$CLEAN_HTTP" = "204" ]; then
    ok "cleanup DELETE note $NOTE_ID via FUB API succeeded (HTTP $CLEAN_HTTP)"
  else
    bad "cleanup: HTTP $CLEAN_HTTP (manually delete note $NOTE_ID in FUB)"
  fi
else
  bad "createNote: $(echo "$NOTE_RESP" | head -c 300)"
fi

# 1.9 Concurrent sessions — open 2 more, verify they don't interfere
SESSION2_HDRS=$(curl -s -X POST "$BASE/mcp" \
  -H "Authorization: Bearer $BEARER" -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" -D - \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"sess2","version":"1"}}}')
SESSION2=$(echo "$SESSION2_HDRS" | grep -i "mcp-session-id" | head -1 | awk '{print $2}' | tr -d '\r')

SESSION3_HDRS=$(curl -s -X POST "$BASE/mcp" \
  -H "Authorization: Bearer $BEARER" -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" -D - \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"sess3","version":"1"}}}')
SESSION3=$(echo "$SESSION3_HDRS" | grep -i "mcp-session-id" | head -1 | awk '{print $2}' | tr -d '\r')

if [ -n "$SESSION2" ] && [ -n "$SESSION3" ] && [ "$SESSION" != "$SESSION2" ] && [ "$SESSION2" != "$SESSION3" ]; then
  ok "three concurrent sessions get distinct ids"
else
  bad "session ids: 1=$SESSION 2=$SESSION2 3=$SESSION3"
fi

# 1.10 Each session can still call tools
RESP=$(curl -s -X POST "$BASE/mcp" \
  -H "Authorization: Bearer $BEARER" -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" -H "Mcp-Session-Id: $SESSION2" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"getIdentity","arguments":{}}}')
if echo "$RESP" | grep -q 'account'; then
  ok "session 2 can call tools"
else
  bad "session 2 getIdentity: $(echo "$RESP" | head -c 200)"
fi

# 1.11 Unknown session ID rejected
RESP=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/mcp" \
  -H "Authorization: Bearer $BEARER" -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" -H "Mcp-Session-Id: bogus-id-not-real" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')
# StreamableHTTPServerTransport behavior: may auto-create OR may reject. Either is OK
# as long as it doesn't crash. Just confirm we get a sane HTTP code.
if [ "$RESP" = "400" ] || [ "$RESP" = "404" ] || [ "$RESP" = "200" ]; then
  ok "unknown session id handled gracefully (HTTP $RESP)"
else
  bad "unknown session id: HTTP $RESP"
fi

# Kill bearer server
kill $SERVER_PID 2>/dev/null
wait 2>/dev/null

# --- Section 2: OAuth 2.1 mode (DCR + PKCE + password) --------------------
echo
echo "===== Section 2: OAuth 2.1 mode (DCR + PKCE + password) ====="
AUTH_PASSWORD="test-pass-$(date +%s)"
MCP_TRANSPORT=http PORT=$PORT MCP_AUTH_PASSWORD="$AUTH_PASSWORD" FUB_API_KEY="$FUB_API_KEY" FUB_SAFE_MODE=true node index.js > /tmp/mcp-oauth.log 2>&1 &
SERVER_PID=$!
sleep 2

# 2.1 Health says oauth2.1
RESP=$(curl -fsS -m 5 "$BASE/health")
if echo "$RESP" | grep -q '"authMode":"oauth2.1"'; then
  ok "health endpoint returns authMode=oauth2.1"
else
  bad "health (oauth): $RESP"
fi

# 2.2 DCR: register a client
REG_RESP=$(curl -s -X POST "$BASE/oauth/register" \
  -H "Content-Type: application/json" \
  -d '{"redirect_uris":["http://localhost:9999/callback"],"client_name":"bet-your-life-test"}')
CLIENT_ID=$(echo "$REG_RESP" | grep -oE '"client_id":"[a-f0-9]+"' | head -1 | sed 's/.*:"//;s/"$//')
if [ -n "$CLIENT_ID" ]; then
  ok "DCR registered client_id=${CLIENT_ID:0:8}..."
else
  bad "DCR register: $REG_RESP"
fi

# 2.3 PKCE: generate verifier + S256 challenge
VERIFIER=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")
CHALLENGE=$(node -e "console.log(require('crypto').createHash('sha256').update('$VERIFIER').digest('base64url'))")
ok "PKCE verifier (${#VERIFIER} chars) + S256 challenge generated"

# 2.4 GET /oauth/authorize renders password form
AUTHZ_URL="$BASE/oauth/authorize?client_id=$CLIENT_ID&redirect_uri=http%3A%2F%2Flocalhost%3A9999%2Fcallback&state=xyz&code_challenge=$CHALLENGE&code_challenge_method=S256&response_type=code"
FORM=$(curl -s "$AUTHZ_URL")
if echo "$FORM" | grep -q "Follow Up Boss MCP Authorization" && echo "$FORM" | grep -q 'name="password"'; then
  ok "GET /oauth/authorize renders password form"
else
  bad "authorize GET: $(echo "$FORM" | head -c 200)"
fi

# 2.5 POST /oauth/authorize with WRONG password — should redirect back with error
WRONG_REDIR=$(curl -s -o /dev/null -w '%{redirect_url}' -X POST "$BASE/oauth/authorize" \
  -d "client_id=$CLIENT_ID&redirect_uri=http://localhost:9999/callback&state=xyz&code_challenge=$CHALLENGE&password=WRONG_PASSWORD")
if echo "$WRONG_REDIR" | grep -q "err=Wrong"; then
  ok "POST authorize wrong password redirects with err"
else
  bad "wrong-password redirect: $WRONG_REDIR"
fi

# 2.6 POST /oauth/authorize with CORRECT password — should redirect with code
REDIR_URL=$(curl -s -o /dev/null -w '%{redirect_url}' -X POST "$BASE/oauth/authorize" \
  -d "client_id=$CLIENT_ID&redirect_uri=http://localhost:9999/callback&state=xyz&code_challenge=$CHALLENGE&password=$AUTH_PASSWORD")
CODE=$(echo "$REDIR_URL" | grep -oE 'code=[a-f0-9]+' | sed 's/code=//')
if [ -n "$CODE" ]; then
  ok "POST authorize correct password issued code=${CODE:0:8}..."
else
  bad "authorize redirect: $REDIR_URL"
fi

# 2.7 Exchange code for access token at /oauth/token
TOKEN_RESP=$(curl -s -X POST "$BASE/oauth/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=authorization_code&code=$CODE&redirect_uri=http://localhost:9999/callback&client_id=$CLIENT_ID&code_verifier=$VERIFIER")
ACCESS_TOKEN=$(echo "$TOKEN_RESP" | grep -oE '"access_token":"[a-f0-9]+"' | sed 's/.*:"//;s/"$//')
if [ -n "$ACCESS_TOKEN" ]; then
  ok "token exchange returned access_token (${#ACCESS_TOKEN} chars)"
else
  bad "token exchange: $TOKEN_RESP"
fi

# 2.8 Code is single-use — reusing it should fail
REUSE_RESP=$(curl -s -X POST "$BASE/oauth/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=authorization_code&code=$CODE&redirect_uri=http://localhost:9999/callback&client_id=$CLIENT_ID&code_verifier=$VERIFIER")
if echo "$REUSE_RESP" | grep -q "invalid_grant"; then
  ok "code reuse rejected with invalid_grant"
else
  bad "code reuse: $REUSE_RESP"
fi

# 2.9 Use access token to initialize MCP
INIT_HDRS=$(curl -s -X POST "$BASE/mcp" \
  -H "Authorization: Bearer $ACCESS_TOKEN" -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" -D - \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"oauth-test","version":"1"}}}')
OAUTH_SESSION=$(echo "$INIT_HDRS" | grep -i "mcp-session-id" | head -1 | awk '{print $2}' | tr -d '\r')
if echo "$INIT_HDRS" | grep -q '"serverInfo"'; then
  ok "MCP initialize with OAuth access_token works"
else
  bad "OAuth initialize: $(echo "$INIT_HDRS" | head -c 200)"
fi

# 2.10 Use OAuth session to call a tool
RESP=$(curl -s -X POST "$BASE/mcp" \
  -H "Authorization: Bearer $ACCESS_TOKEN" -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" -H "Mcp-Session-Id: $OAUTH_SESSION" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"listNotes","arguments":{"limit":1}}}')
if echo "$RESP" | grep -q 'notes'; then
  ok "OAuth session calls listNotes and gets real data"
else
  bad "OAuth listNotes: $(echo "$RESP" | head -c 200)"
fi

# 2.11 Invalid access token rejected
HTTP=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/mcp" \
  -H "Authorization: Bearer not-a-real-token" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}')
[ "$HTTP" = "401" ] && ok "invalid OAuth token rejected with 401" || bad "invalid token: HTTP $HTTP"

# 2.12 PKCE verifier mismatch should reject
BAD_VERIFIER=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")
# Need a fresh code first
REDIR_URL2=$(curl -s -o /dev/null -w '%{redirect_url}' -X POST "$BASE/oauth/authorize" \
  -d "client_id=$CLIENT_ID&redirect_uri=http://localhost:9999/callback&state=xyz&code_challenge=$CHALLENGE&password=$AUTH_PASSWORD")
CODE2=$(echo "$REDIR_URL2" | grep -oE 'code=[a-f0-9]+' | sed 's/code=//')
BAD_PKCE_RESP=$(curl -s -X POST "$BASE/oauth/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=authorization_code&code=$CODE2&redirect_uri=http://localhost:9999/callback&client_id=$CLIENT_ID&code_verifier=$BAD_VERIFIER")
if echo "$BAD_PKCE_RESP" | grep -q "PKCE verification failed"; then
  ok "PKCE verifier mismatch rejected"
else
  bad "PKCE mismatch: $BAD_PKCE_RESP"
fi

# Kill OAuth server
kill $SERVER_PID 2>/dev/null
wait 2>/dev/null

# --- Section 3: OAuth state survives a server restart ----------------------
# Regression test for: in-memory client/token registry wiped on every
# redeploy, forcing every connected client to re-auth (Invalid client_id).
echo
echo "===== Section 3: OAuth persistence across restart ====="
STORE_PATH="/tmp/oauth-store-test-$(date +%s).json"
rm -f "$STORE_PATH"
AUTH_PASSWORD="test-pass-restart-$(date +%s)"

MCP_TRANSPORT=http PORT=$PORT MCP_AUTH_PASSWORD="$AUTH_PASSWORD" MCP_OAUTH_STORE_PATH="$STORE_PATH" FUB_API_KEY="$FUB_API_KEY" FUB_SAFE_MODE=true node index.js > /tmp/mcp-restart-1.log 2>&1 &
SERVER_PID=$!
sleep 2

# 3.1 Register a client, run full flow to get an access token
REG_RESP=$(curl -s -X POST "$BASE/oauth/register" -H "Content-Type: application/json" -d '{"redirect_uris":["http://localhost:9999/callback"],"client_name":"restart-test"}')
CLIENT_ID=$(echo "$REG_RESP" | grep -oE '"client_id":"[a-f0-9]+"' | head -1 | sed 's/.*:"//;s/"$//')
[ -n "$CLIENT_ID" ] && ok "pre-restart: registered client_id=${CLIENT_ID:0:8}..." || bad "pre-restart register: $REG_RESP"

VERIFIER=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")
CHALLENGE=$(node -e "console.log(require('crypto').createHash('sha256').update('$VERIFIER').digest('base64url'))")

REDIR_URL=$(curl -s -o /dev/null -w '%{redirect_url}' -X POST "$BASE/oauth/authorize" -d "client_id=$CLIENT_ID&redirect_uri=http://localhost:9999/callback&state=xyz&code_challenge=$CHALLENGE&password=$AUTH_PASSWORD")
CODE=$(echo "$REDIR_URL" | grep -oE 'code=[a-f0-9]+' | sed 's/code=//')
[ -n "$CODE" ] && ok "pre-restart: got auth code" || bad "pre-restart authorize: $REDIR_URL"

TOKEN_RESP=$(curl -s -X POST "$BASE/oauth/token" -H "Content-Type: application/x-www-form-urlencoded" -d "grant_type=authorization_code&code=$CODE&redirect_uri=http://localhost:9999/callback&client_id=$CLIENT_ID&code_verifier=$VERIFIER")
ACCESS_TOKEN=$(echo "$TOKEN_RESP" | grep -oE '"access_token":"[a-f0-9]+"' | sed 's/.*:"//;s/"$//')
[ -n "$ACCESS_TOKEN" ] && ok "pre-restart: got access_token" || bad "pre-restart token: $TOKEN_RESP"

[ -f "$STORE_PATH" ] && ok "store file written to disk at $STORE_PATH" || bad "store file missing after register+token"

# 3.2 Kill the process -- simulates a redeploy/crash/reboot
kill $SERVER_PID 2>/dev/null
wait 2>/dev/null
sleep 1

# 3.3 Start a brand-new process, same store path, NO re-registration
MCP_TRANSPORT=http PORT=$PORT MCP_AUTH_PASSWORD="$AUTH_PASSWORD" MCP_OAUTH_STORE_PATH="$STORE_PATH" FUB_API_KEY="$FUB_API_KEY" FUB_SAFE_MODE=true node index.js > /tmp/mcp-restart-2.log 2>&1 &
SERVER_PID=$!
sleep 2

# 3.4 Old client_id must still be recognized (this is the bug we're fixing --
# used to fail with 400 'Invalid client_id' here)
AUTHZ_URL="$BASE/oauth/authorize?client_id=$CLIENT_ID&redirect_uri=http%3A%2F%2Flocalhost%3A9999%2Fcallback&state=xyz&code_challenge=$CHALLENGE&code_challenge_method=S256&response_type=code"
FORM=$(curl -s "$AUTHZ_URL")
if echo "$FORM" | grep -q "Follow Up Boss MCP Authorization" && ! echo "$FORM" | grep -qi "Invalid client_id"; then
  ok "post-restart: old client_id still recognized (no re-registration needed)"
else
  bad "post-restart authorize: $(echo "$FORM" | head -c 200)"
fi

# 3.5 Old access_token (issued before restart) must still authenticate /mcp
INIT_RESP=$(curl -s -X POST "$BASE/mcp" -H "Authorization: Bearer $ACCESS_TOKEN" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"restart-test","version":"1"}}}')
if echo "$INIT_RESP" | grep -q '"serverInfo"'; then
  ok "post-restart: pre-restart access_token still authenticates /mcp"
else
  bad "post-restart token auth: $(echo "$INIT_RESP" | head -c 200)"
fi

# Cleanup
kill $SERVER_PID 2>/dev/null
wait 2>/dev/null
rm -f "$STORE_PATH" "${STORE_PATH}.tmp"

# --- Summary --------------------------------------------------------------
echo
echo "===================================================="
echo "$PASS passed, $FAIL failed"
echo "===================================================="
exit $FAIL
