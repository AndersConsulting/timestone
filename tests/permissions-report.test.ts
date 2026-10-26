import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatPermissions } from '../supabase/functions/_shared/permissions-report.ts';

test('Berechtigungen: ASCII-Rahmen, echte Rolle und erlaubte Funktionen', () => {
  const text = formatPermissions({ role:'Manager', permissions:[{code:'attendance.create_self',label:'Eigene Zeiten anlegen'},{code:'vacation.read_team',label:'Teamurlaub ansehen'}],notes:['Nur direktes Team.'] });
  assert.match(text,/Du bist: Manager/);
  assert.match(text,/- Eigene Zeiten anlegen/);
  assert.match(text,/- Teamurlaub ansehen/);
  assert.ok([...text].every(c => c.charCodeAt(0) < 128));
  assert.equal(new Set(text.split('\n').map(line => line.length)).size,1);
  assert.doesNotMatch(text,/Admin|genehmigen/);
  assert.throws(() => formatPermissions({role:'Superuser',permissions:[],notes:[]} as any));
});
