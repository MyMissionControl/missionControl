#!/usr/bin/env bash
# install.sh — ดึง skill ในโฟลเดอร์นี้ไปวางที่ ~/.claude/skills/ (live location ที่ Claude Code โหลด)
# ใช้ตอน clone missionControl/soulbrew ไปเครื่องใหม่ แล้วอยากใช้ /orches
#
#   bash claude-skills/install.sh
#
# เสร็จแล้ว reload / restart Claude Code → /orches จะขึ้นใน autocomplete
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/.claude/skills"

# รายชื่อ skill ที่จะ install (ชื่อ = ชื่อโฟลเดอร์ใน claude-skills/)
SKILLS=(orches)

mkdir -p "$DEST"
for skill in "${SKILLS[@]}"; do
  if [ ! -f "$SRC/$skill/SKILL.md" ]; then
    echo "✗ ข้าม $skill — ไม่เจอ $SRC/$skill/SKILL.md"
    continue
  fi
  # ⛔⛔ ห้ามเขียนทะลุ symlink: ~/.claude/skills/<skill> บนเครื่องนี้เป็น symlink เข้า
  #   orches-skills/skills/orches อยู่ ⇒ `mkdir -p` ผ่านเฉย ๆ แล้ว `cp` เขียนทะลุลงไฟล์จริงใน repo
  #   (พิสูจน์แล้ว) ⇒ สำเนาเก่า 20,481B ของ 2026-07-01 จะทับของจริง 4,448B
  #   และ SKILL.md.bak.* จะไปโผล่เป็นขยะใน repo นั้นด้วย
  if [ -L "$DEST/$skill" ]; then
    tgt="$(readlink -f "$DEST/$skill" 2>/dev/null || readlink "$DEST/$skill")"
    if [ -f "$tgt/SKILL.md" ]; then
      echo "✓ /$skill ติดตั้งอยู่แล้วแบบ symlink → $tgt (ข้าม — นั่นคือต้นทางที่แท้จริง)"
    else
      echo "✗ /$skill เป็น symlink ที่พัง → $tgt (ไม่เจอ SKILL.md) — ซ่อม symlink เอง ห้ามให้สคริปต์นี้เขียนทับ"
    fi
    continue
  fi
  # ⭐ ถ้า orches-skills อยู่ใน workspace เดียวกัน → symlink ดีกว่า copy เพราะมันจะไม่ drift อีก
  live=""
  for cand in "$SRC/../../orches-skills/skills/$skill" "$SRC/../../../fufu-2345/orches-skills/skills/$skill"; do
    [ -f "$cand/SKILL.md" ] && { live="$(cd "$cand" && pwd)"; break; }
  done
  if [ -n "$live" ]; then
    rm -rf "$DEST/$skill"
    ln -s "$live" "$DEST/$skill"
    echo "✓ linked /$skill → $live (ต้นทางเดียว ไม่ drift)"
    continue
  fi
  # ↳ ไม่มี repo ต้นทาง → copy ได้ แต่ต้องบอกวันที่สำเนา ออกมาด้วย (มันอาจเก่า)
  echo "  ! ไม่เจอ orches-skills ใน workspace — จะ copy สำเนาใน repo นี้แทน"
  # ⛔ ห้ามใช้ mtime บอกความเก่า: git clone/cp รีเซ็ต mtime เป็นเวลาปัจจุบัน ⇒ บนเครื่องใหม่
  #   จะขึ้น "วันนี้" ตลอดและไม่เคยดูเก่าเลย · วันที่ commit ล่าสุดของไฟล์รอด clone
  # ⛔ ต้องมี || true: ใต้ set -e การ assign จาก command substitution ที่คืน non-zero
  #   (เช่นโฟลเดอร์นี้ไม่ได้อยู่ใน git) จะฆ่าสคริปต์ทิ้งเงียบ ๆ กลางทาง — เจอมาแล้วตอนเทส
  cdate="$(git -C "$SRC" log -1 --format=%as -- "$skill/SKILL.md" 2>/dev/null || true)"
  echo "    สำเนานี้ commit ล่าสุด: ${cdate:-ไม่ทราบ (ไม่ได้อยู่ใน git)} ($(wc -c < "$SRC/$skill/SKILL.md") bytes) — อาจเก่ากว่าต้นทางใน orches-skills"
  mkdir -p "$DEST/$skill"
  # สำรองของเดิมถ้ามี (กันทับงานที่ยังไม่ได้ commit)
  if [ -f "$DEST/$skill/SKILL.md" ] && ! cmp -s "$SRC/$skill/SKILL.md" "$DEST/$skill/SKILL.md"; then
    cp "$DEST/$skill/SKILL.md" "$DEST/$skill/SKILL.md.bak.$(date +%s 2>/dev/null || echo prev)"
    echo "  (ของเดิมต่างกัน — สำรองเป็น SKILL.md.bak.* ก่อนทับ)"
  fi
  cp "$SRC/$skill/SKILL.md" "$DEST/$skill/SKILL.md"
  echo "✓ installed /$skill → $DEST/$skill/SKILL.md"
done

echo
echo "เสร็จ — reload / restart Claude Code แล้วพิมพ์ /orches ได้เลย"
