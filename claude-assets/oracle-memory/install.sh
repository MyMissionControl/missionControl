#!/usr/bin/env bash
# install.sh — วางกลไก "Oracle memory: shared / isolate" ไปที่ ~/.claude (live location)
#
#   bash claude-assets/oracle-memory/install.sh
#
# ทำไมของพวกนี้อยู่ใน repo นี้: หน้า Settings ของ extension (Oracle memory section)
# ไม่ได้แก้ config เอง แต่ shell out มาเรียก oracle-tenant-migrate.ts ตัวนี้ —
# UI กับ CLI จึงต้องอยู่ commit เดียวกัน ไม่งั้น contract (--json / --isolate) เพี้ยนเงียบๆ
# arra-oracle-v3 เป็น legacy read-only จึงไม่แก้ engine เลย ทุกอย่างอยู่นอกตัว engine
#
# กลไกย่อ: มี 2 สวิตช์ใน ~/.claude/oracle-tenant-map.json
#   vaults        = ติดป้าย tenant_id ให้ doc ของ vault นั้น (ยังไม่ซ่อนอะไร)
#   isolateReads  = ตัวที่ทำให้ oracle นั้นค้นเจอแค่ความรู้ตัวเอง
# ทั้งคู่ว่าง = shared เหมือนไม่ได้ติดตั้ง (default ของไฟล์ที่ ship มา)
#
# ไฟล์ที่ install:
#   oracle-tenant.ts           lib: map/ensureTenant/plan/apply+journal/revert/backup
#   oracle-tenant-migrate.ts   CLI: --report --audit --json --apply --revert
#                                   --label --isolate --unisolate --off
#   oracle-tenant-read.ts      ตัวบอก READ tenant จาก cwd (ให้ MCP launcher ใช้)
#   hooks/oracle-isolation-guard.sh  PreToolUse guard กัน ψ ของ vault อื่นตอน isolate
#   oracle-tenant-map.json     ติดตั้งจาก .default.json เฉพาะเมื่อยังไม่มี (เป็น state ของเครื่อง)
#
# 2 อย่างที่ script นี้ "ไม่" แก้ให้ (จงใจ — มันเป็นไฟล์ที่มีของอย่างอื่นอยู่):
#   ~/.claude/settings.json              ต้องเติม hook 1 บล็อกเอง
#   ~/.claude/oracle-reindex-append.ts   ต้องแปะ block stampTenant() เอง
# script จะตรวจให้ว่าต่อสายแล้วหรือยัง แล้วพิมพ์ของที่ต้องเติมให้ copy
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/.claude"
GUARD="$DEST/hooks/oracle-isolation-guard.sh"

mkdir -p "$DEST/hooks"
for f in oracle-tenant.ts oracle-tenant-migrate.ts oracle-tenant-read.ts; do
  cp "$SRC/$f" "$DEST/$f"
  echo "[ok] $DEST/$f"
done
cp "$SRC/hooks/oracle-isolation-guard.sh" "$GUARD"
chmod +x "$GUARD"
echo "[ok] $GUARD"

# state ของเครื่อง — ห้ามทับ ไม่งั้น isolate ที่ตั้งไว้หายทั้งหมด
if [ -e "$DEST/oracle-tenant-map.json" ]; then
  echo "[keep] $DEST/oracle-tenant-map.json (มีอยู่แล้ว — ไม่ทับ)"
else
  cp "$SRC/oracle-tenant-map.default.json" "$DEST/oracle-tenant-map.json"
  echo "[ok] $DEST/oracle-tenant-map.json (เริ่มที่ปิดทั้งหมด)"
fi

need_manual=0

if grep -q "oracle-isolation-guard.sh" "$DEST/settings.json" 2>/dev/null; then
  echo "[ok] settings.json: guard hook ต่อสายแล้ว"
else
  need_manual=1
  cat <<'EOF'

[ต้องทำเอง 1] เติมใน ~/.claude/settings.json ที่ hooks.PreToolUse (เพิ่มเป็น entry ใหม่ ไม่ต้องลบของเดิม):

      {
        "matcher": "Read|Grep|Glob|Bash|Edit|Write|NotebookEdit",
        "hooks": [
          { "type": "command", "command": "exec bash \"$HOME/.claude/hooks/oracle-isolation-guard.sh\"" }
        ]
      }

  guard เช็ค marker file ก่อนเป็นอย่างแรก ตอนไม่มีใคร isolate ราคา ~5ms/tool call (floor 3ms) ตอนเปิด ~14ms
EOF
fi

if grep -q "stampTenant" "$DEST/oracle-reindex-append.ts" 2>/dev/null; then
  echo "[ok] oracle-reindex-append.ts: stampTenant ต่อสายแล้ว"
else
  need_manual=1
  echo ""
  echo "[ต้องทำเอง 2] ฝั่งเขียนยังไม่ปิด — indexer ที่ใช้จริงเป็น fork ที่ไม่รู้จัก tenant เลย"
  echo "  แปะ block stampTenant() + เปลี่ยน .then() ตามไฟล์อ้างอิงนี้:"
  echo "    $SRC/oracle-reindex-append.reference.ts"
  echo "  (อ้างอิงเท่านั้น ห้าม copy ทับ — ของจริงมี systemd memory cap + import fork indexer อยู่)"
fi

echo ""
echo "ตรวจสถานะ:  bun $DEST/oracle-tenant-migrate.ts"
echo "เปิดให้ตัวหนึ่ง: bun $DEST/oracle-tenant-migrate.ts --label <vault> && ... --apply && ... --isolate <vault>"
echo "ปิด:          bun $DEST/oracle-tenant-migrate.ts --unisolate <vault>"
[ "$need_manual" = 0 ] && echo "" && echo "ต่อสายครบแล้วทั้งสองจุด" || true
