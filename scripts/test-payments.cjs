// PostgreSQL real, aislado y temporal. No lee .env ni llama Wompi/Supabase/correo.
// Requiere initdb, pg_ctl y psql en PATH. Ejecutar: node scripts/test-payments.cjs
const { execFileSync, execFile } = require('node:child_process')
const { promisify } = require('node:util')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'luxurycaps-payments-'))
const pgdata = path.join(temp, 'pgdata')
const pgArgs = ['-X', '-h', temp, '-p', '55439', '-U', 'payment_test', '-d', 'postgres', '-At', '-v', 'ON_ERROR_STOP=1']
const exec = promisify(execFile)
const env = { ...process.env, PGHOST: temp, PGPORT: '55439', PGUSER: 'payment_test', PGPASSWORD: '', PGDATABASE: 'postgres', LC_ALL: 'C', LANG: 'C' }
delete env.PGSERVICE
delete env.PGSERVICEFILE
const sql = async text => (await exec('psql', [...pgArgs, '-c', text], { env })).stdout.trim()
const runFile = file => execFileSync('psql', [...pgArgs, '-f', file], { env, stdio: 'pipe' })
const O = '11111111-1111-4111-8111-111111111111'
const P = '22222222-2222-4222-8222-222222222222'
const A = '33333333-3333-4333-8333-333333333333'
const q = value => value == null ? 'NULL' : `'${String(value).replaceAll("'", "''")}'`
const apply = (id, status, amount = 200000, currency = 'COP') => sql(`SELECT apply_wompi_transaction('${O}',${q(id)},${q(status)},${amount},${q(currency)},NULL,now(),now())`)
const order = async () => JSON.parse(await sql(`SELECT row_to_json(o) FROM orders o WHERE id='${O}'`))
const stock = async () => Number(await sql(`SELECT stock FROM products WHERE id='${P}'`))
const coupon = async () => Number(await sql("SELECT used_count FROM promotions WHERE code='TEST'"))
const cancel = () => sql(`SELECT cancel_order('${O}',ARRAY['pending','paid','processing'],true,NULL)`)
const recover = async (tx = 'test-approved', opts = {}) => {
  const o = await order()
  return sql(`SELECT recover_cancelled_order('${O}',${q(tx)},${opts.amount ?? 200000},'COP',NULL,'${A}',
    'Pago revisado sin reembolso',${q(opts.updated ?? o.updated_at)},${q(opts.legacy)})`)
}
async function seed() {
  await sql(`TRUNCATE order_payment_recoveries,order_payment_attempts,order_items,orders,products,promotions,profiles;
    INSERT INTO profiles VALUES('${A}',true);
    INSERT INTO products VALUES('${P}',9);
    INSERT INTO promotions VALUES('TEST',0,10,true);
    INSERT INTO orders(id,order_number,total,promo_code) VALUES('${O}','TEST',2000,'TEST');
    INSERT INTO order_items(order_id,product_id,quantity) VALUES('${O}','${P}',1);`)
}
const tests = []
const test = (name, fn) => tests.push({ name, fn })
test('rechazo seguido de aprobación mantiene reserva y paga una vez', async () => {
  for (const status of ['DECLINED', 'ERROR', 'VOIDED']) await apply(`test-${status}`, status)
  assert.equal((await order()).status, 'pending'); assert.equal(await stock(), 9)
  await apply('test-approved', 'APPROVED')
  assert.equal((await order()).status, 'paid'); assert.equal((await order()).payment_issue, null)
  assert.equal(await coupon(), 1); assert.equal(await stock(), 9)
})
test('20 aprobaciones concurrentes no duplican cupón ni inventario', async () => {
  const results = await Promise.all(Array.from({ length: 20 }, () => apply('test-approved', 'APPROVED')))
  assert.equal(results.filter(r => r === 'updated').length, 1)
  assert.equal(await coupon(), 1); assert.equal(await stock(), 9)
})
test('eventos antiguos no revierten un pago aprobado', async () => {
  await apply('test-approved', 'APPROVED')
  for (const s of ['DECLINED', 'ERROR', 'PENDING']) await apply('test-approved', s)
  assert.equal(await sql("SELECT status FROM order_payment_attempts WHERE transaction_id='test-approved'"), 'APPROVED')
  assert.equal((await order()).status, 'paid')
})
test('doble cobro produce alerta y bloquea el despacho', async () => {
  await apply('test-approved', 'APPROVED'); await apply('test-extra', 'APPROVED')
  assert.match((await order()).payment_issue, /DUPLICADO/)
  await assert.rejects(sql(`UPDATE orders SET status='shipped' WHERE id='${O}'`), /PAYMENT_REVIEW_REQUIRED/)
})
test('anulación del cobro válido bloquea despacho; otro intento no lo invalida', async () => {
  await apply('test-approved', 'APPROVED'); await apply('test-other', 'VOIDED')
  assert.equal((await order()).payment_issue, null)
  await apply('test-approved', 'VOIDED')
  assert.match((await order()).payment_issue, /WOMPI_VOIDED/)
  await apply('test-approved', 'APPROVED')
  assert.equal(await sql("SELECT status FROM order_payment_attempts WHERE transaction_id='test-approved'"), 'VOIDED')
})
test('monto y moneda incorrectos nunca pagan el pedido', async () => {
  await apply('test-wrong-amount', 'APPROVED', 199900)
  await apply('test-wrong-currency', 'APPROVED', 200000, 'USD')
  assert.equal((await order()).status, 'pending'); assert.equal(await coupon(), 0)
  assert.match((await order()).payment_issue, /WOMPI_AMOUNT_MISMATCH/)
})
test('expiración cancela y libera stock sólo una vez', async () => {
  await sql(`UPDATE orders SET created_at=now()-interval '3 hours'`)
  await sql('SELECT expire_pending_orders(); SELECT expire_pending_orders()')
  assert.equal((await order()).status, 'cancelled'); assert.equal(await stock(), 10)
  assert.equal((await order()).cancelled_from, 'pending')
})
test('aprobación tardía exige recuperación y vuelve a reservar stock', async () => {
  await cancel(); await apply('test-approved', 'APPROVED')
  assert.equal((await order()).status, 'cancelled'); assert.equal(await stock(), 10)
  await recover()
  assert.equal((await order()).status, 'paid'); assert.equal(await stock(), 9)
  assert.equal((await order()).payment_issue, null); assert.equal(await coupon(), 1)
  assert.equal(await sql('SELECT count(*) FROM order_payment_recoveries'), '1')
  await assert.rejects(recover(), /ORDER_CHANGED/)
  await apply('test-approved', 'APPROVED'); assert.equal(await coupon(), 1)
})
test('recuperación también funciona antes de recibir el webhook aprobado', async () => {
  await cancel(); await recover()
  assert.equal((await order()).status, 'paid'); assert.equal(await stock(), 9)
})
test('sin stock la recuperación revierte cupón, historial y pedido', async () => {
  await cancel(); await apply('test-approved', 'APPROVED'); await sql('UPDATE products SET stock=0')
  const before = await order()
  await assert.rejects(recover(), /OUT_OF_STOCK/)
  assert.deepEqual(await order(), before); assert.equal(await coupon(), 0)
  assert.equal(await sql('SELECT count(*) FROM order_payment_recoveries'), '0')
})
test('doble clic concurrente recupera y reserva sólo una vez', async () => {
  await cancel(); await apply('test-approved', 'APPROVED')
  const results = await Promise.allSettled([recover(), recover()])
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
  assert.equal(await stock(), 9); assert.equal(await coupon(), 1)
})
test('recuperar un pedido anteriormente pagado no cuenta dos veces el cupón', async () => {
  await apply('test-approved', 'APPROVED'); await cancel(); await recover()
  assert.equal(await coupon(), 1); assert.equal(await stock(), 9)
})
test('no recupera pedidos despachados ni una revisión con cambios concurrentes', async () => {
  await cancel()
  await assert.rejects(recover('test-approved', { updated: '2000-01-01T00:00:00Z' }), /ORDER_CHANGED/)
  await sql('UPDATE orders SET shipped_at=now()')
  await assert.rejects(recover(), /ORDER_ALREADY_DISPATCHED/)
})
test('pedido legado sólo se recupera con intento anterior fallido verificado', async () => {
  await sql(`UPDATE orders SET status='cancelled',wompi_transaction_id='test-declined'; UPDATE products SET stock=10`)
  await assert.rejects(recover(), /LEGACY_CANCELLATION_UNKNOWN/)
  await recover('test-approved', { legacy: 'test-declined' })
  assert.equal((await order()).status, 'paid'); assert.equal(await coupon(), 1); assert.equal(await stock(), 9)
})
test('no borra alertas de otros cobros al recuperar', async () => {
  await cancel(); await apply('test-approved', 'APPROVED'); await apply('test-extra', 'APPROVED')
  await assert.rejects(recover(), /OTHER_PAYMENT_ISSUES/)
  assert.equal((await order()).status, 'cancelled'); assert.equal(await stock(), 10)
})
test('conciliación cerrada no se reabre con webhooks ni permite recuperar ese pago', async () => {
  await cancel(); await apply('test-approved', 'APPROVED')
  await sql(`SELECT resolve_order_payment_issue('${O}','${A}','Reembolso completado',payment_issue) FROM orders`)
  await apply('test-approved', 'APPROVED')
  assert.equal((await order()).payment_issue, null)
  await assert.rejects(recover(), /PAYMENT_NOT_RECOVERABLE/)
})
test('una nueva anulación no se oculta por una conciliación anterior', async () => {
  await apply('test-approved', 'APPROVED'); await apply('test-extra', 'APPROVED')
  await sql(`SELECT resolve_order_payment_issue('${O}','${A}','Cobro extra reembolsado',payment_issue) FROM orders`)
  await apply('test-approved', 'VOIDED')
  assert.match((await order()).payment_issue, /WOMPI_VOIDED/)
})
test('rechazos del backend anterior tampoco cancelan ni liberan stock', async () => {
  assert.equal(await sql(`SELECT apply_failed_wompi_transaction('${O}','test-failed','DECLINED')`), 'noop')
  assert.equal((await order()).status, 'pending'); assert.equal(await stock(), 9)
})
test('roles del navegador no pueden ejecutar recuperación ni escribir intentos', async () => {
  await assert.rejects(sql(`SET ROLE authenticated; SELECT recover_cancelled_order('${O}','test-approved',200000,'COP',NULL,'${A}','Motivo',now(),NULL)`), /permission denied/)
  await assert.rejects(sql('SET ROLE anon; SELECT * FROM order_payment_attempts'), /permission denied/)
})
test('aprobación y expiración concurrentes conservan dinero e inventario', async () => {
  for (let i = 0; i < 10; i++) {
    await seed(); await sql(`UPDATE orders SET created_at=now()-interval '3 hours'`)
    await Promise.all([apply('test-approved', 'APPROVED'), sql('SELECT expire_pending_orders()')])
    const o = await order()
    if (o.status === 'paid') { assert.equal(await stock(), 9); assert.equal(await coupon(), 1) }
    else { assert.equal(o.status, 'cancelled'); assert.match(o.payment_issue, /APROBÓ/); assert.equal(await stock(), 10) }
  }
})
test('alerta anterior al parche de OTRO cobro bloquea la recuperación', async () => {
  await sql(`UPDATE orders SET status='cancelled',wompi_transaction_id='test-declined',
    payment_issue='Wompi APROBÓ el pago (transacción test-legacyA) pero el pedido estaba cancelado. Reembolsa o despacha manualmente.';
    UPDATE products SET stock=10`)
  await assert.rejects(recover('test-approved', { legacy: 'test-declined' }), /OTHER_PAYMENT_ISSUES/)
  assert.equal((await order()).status, 'cancelled'); assert.match((await order()).payment_issue, /test-legacyA/)
  assert.equal(await stock(), 10)
})
test('alerta antigua de monto distinto bloquea la recuperación', async () => {
  await cancel(); await apply('test-approved', 'APPROVED')
  await sql(`UPDATE orders SET payment_issue = payment_issue || E'\\n' || 'Wompi aprobó la transacción test-mm por 100 COP (centavos), pero el pedido es de 200000 COP. NO se marcó como pagado: revisa y reembolsa.'`)
  await assert.rejects(recover(), /OTHER_PAYMENT_ISSUES/)
  assert.match((await order()).payment_issue, /test-mm/)
})
test('la recuperación conserva en el historial la alerta que cierra', async () => {
  await cancel(); await apply('test-approved', 'APPROVED')
  await recover()
  const o = await order()
  assert.equal(o.payment_issue, null)
  assert.match(o.payment_issue_resolved, /APROBÓ el pago \(transacción test-approved\)/)
  assert.match(o.payment_issue_resolved, /Pedido recuperado por admin .* con la transacción test-approved: Pago revisado/)
})

;(async () => {
  let started = false
  try {
    execFileSync('initdb', ['-D', pgdata, '-A', 'trust', '-U', 'payment_test', '--no-locale', '-E', 'UTF8'], { env, stdio: 'pipe' })
    execFileSync('pg_ctl', ['-D', pgdata, '-l', path.join(temp, 'postgres.log'), '-o', `-k ${temp} -p 55439 -h ''`, 'start'], { env, stdio: 'pipe' })
    started = true
    runFile(path.join(__dirname, 'fixtures/payment-schema.sql'))
    const base = fs.readFileSync(path.join(root, 'supabase-security-fix.sql'), 'utf8')
    for (const name of ['reserve_stock', 'release_order_stock']) {
      const start = base.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`)
      await sql(base.slice(start, base.indexOf('$$;', start) + 3))
    }
    for (const file of ['supabase-security-fix-5.sql','supabase-security-fix-6.sql','supabase-security-fix-8.sql','supabase-security-fix-8.sql']) runFile(path.join(root, file))
    for (const { name, fn } of tests) {
      await seed()
      try { await fn(); console.log('PASS', name) }
      catch (error) { console.error('FAIL', name, error.message); process.exitCode = 1 }
    }
    console.log(`${tests.length} escenarios de pagos ejecutados en PostgreSQL temporal.`)
  } finally {
    if (started) execFileSync('pg_ctl', ['-D', pgdata, '-m', 'fast', 'stop'], { env, stdio: 'pipe' })
    fs.rmSync(temp, { recursive: true, force: true })
  }
})().catch(error => { console.error(error.message, error.stderr?.toString()); process.exitCode = 1 })
