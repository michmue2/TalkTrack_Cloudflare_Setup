#!/bin/bash
READ="Your Read API KEY"
WRITE="Your write secret"
BASE="http://localhost:8787"

echo "=== 1. Wrong key → 401 ==="
curl -s -o /dev/null -w "HTTP %{http_code}\n" "$BASE/expenses" -H "Authorization: Bearer badkey"

echo "=== 2. GET /categories (empty DB) ==="
curl -s "$BASE/categories" -H "Authorization: Bearer $READ"
echo ""

echo "=== 3. GET /expenses (empty DB) ==="
curl -s "$BASE/expenses" -H "Authorization: Bearer $READ"
echo ""

echo "=== 4. POST /sync with wrong write secret → 401 ==="
curl -s -o /dev/null -w "HTTP %{http_code}\n" -X POST "$BASE/sync" \
  -H "Content-Type: application/json" \
  -H "X-Write-Secret: wrongsecret" \
  -d '{}'

echo "=== 5. POST /sync (push test data) ==="
curl -s -X POST "$BASE/sync" \
  -H "Content-Type: application/json" \
  -H "X-Write-Secret: $WRITE" \
  -d '{
    "categories": [{"id":"cat-1","name":"Groceries","icon":"cart","is_default":1,"sort_order":0}],
    "expenses": [
      {"id":"exp-1","amount":42.50,"note":"Supermarket","category_id":"cat-1",
       "date":"2026-02-20T10:00:00Z","created_at":"2026-02-20T10:00:00Z",
       "raw_transcript":"42.50 groceries","status":"confirmed","source":"voice","categorization_source":"ai"},
      {"id":"exp-2","amount":12.00,"note":"Coffee","category_id":"cat-1",
       "date":"2026-02-21T08:00:00Z","created_at":"2026-02-21T08:00:00Z",
       "raw_transcript":"12 coffee","status":"confirmed","source":"voice","categorization_source":"ai"}
    ],
    "budget_defaults": [{"id":"bd-1","category_id":"cat-1","monthly_amount":300,"effective_from":"2026-01-01T00:00:00Z","created_at":"2026-01-01T00:00:00Z"}],
    "budget_overrides": [],
    "recurring": []
  }'
echo ""

echo "=== 6. GET /expenses after sync ==="
curl -s "$BASE/expenses" -H "Authorization: Bearer $READ"
echo ""

echo "=== 7. GET /summary?month=2026-02 ==="
curl -s "$BASE/summary?month=2026-02" -H "Authorization: Bearer $READ"
echo ""

echo "=== 8. GET /export/csv (first 6 lines) ==="
curl -s "$BASE/export/csv" -H "Authorization: Bearer $READ" | head -6
