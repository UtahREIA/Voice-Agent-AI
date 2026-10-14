/**
 * test-find-resources.js — paired test cards for the find_resources endpoint.
 *
 * Hits the deployed /api/find-resources directly (no Vapi needed) and prints the
 * matches per need, so we can check quality + the V1-lesson rules before the tool
 * is ever attached to an assistant. Spec: claude/LANI-VENDOR-LOOKUP-SPEC.md §7.
 *
 * Run (PowerShell):
 *   node scripts/test-find-resources.js
 *   $env:FIND_URL="https://voice-agent-ai-nu.vercel.app/api/find-resources"; node scripts/test-find-resources.js
 */

const URL = process.env.FIND_URL || 'https://voice-agent-ai-nu.vercel.app/api/find-resources';

const CARDS = [
  { label: 'Active investor raising capital (educator)',
    needs: [{ type: 'educator', topic: 'raising capital', level: 'active' }] },
  { label: 'Fix & flip needs a hard money lender in Salt Lake',
    needs: [{ type: 'vendor', service: 'hard money lender', topic: 'fix and flip', county: 'Salt Lake' }] },
  { label: 'New investor wants a wholesaling class',
    needs: [{ type: 'class', topic: 'wholesaling', level: 'new' }] },
  { label: 'Property manager, NO location (expect needs_location)',
    needs: [{ type: 'vendor', service: 'property manager' }] },
  { label: 'Passive investor education (expect closest_fit via commercial? or topic)',
    needs: [{ type: 'educator', topic: 'passive investments', level: 'experienced' }] },
  { label: 'Out-of-state lender (expect coverage_warning)',
    needs: [{ type: 'vendor', service: 'lender', state: 'TX' }] },
  { label: 'Utah REIA resource need',
    needs: [{ type: 'utah_reia', topic: 'raising capital' }] },
  { label: 'Upcoming event on fix and flip',
    needs: [{ type: 'event', topic: 'fix and flip' }] },
  { label: 'Multi-need (educator + vendor + tool) in one call',
    needs: [
      { type: 'educator', topic: 'buy and hold rentals', level: 'getting started' },
      { type: 'vendor', service: 'property manager', county: 'Utah' },
      { type: 'tool', topic: 'fix and flip' }
    ] }
];

async function run() {
  for (const card of CARDS) {
    console.log('\n==== ' + card.label + ' ====');
    try {
      const r = await fetch(URL, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ needs: card.needs })
      });
      const j = await r.json();
      const result = j.results?.[0]?.result || j.result || JSON.stringify(j);
      let parsed; try { parsed = JSON.parse(result); } catch { parsed = result; }
      if (parsed?.needs) {
        for (const n of parsed.needs) {
          const names = n.matches.map(m => `${m.name} [${m.cost}${m.booking_link ? ', book' : ''}${m.closest_fit ? ', closest-fit' : ''}${m.coverage_warning ? ', ' + m.coverage_warning : ''}]`);
          console.log(`  ${n.type}: ${n.status}${n.note ? ' (' + n.note + ')' : ''}`);
          names.forEach(x => console.log('     - ' + x));
        }
      } else {
        console.log('  ', parsed);
      }
    } catch (e) { console.log('  REQUEST FAILED:', e.message); }
  }
}
run();
