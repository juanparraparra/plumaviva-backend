// Carga los datos de demostración del prototipo en la base de datos.
// Uso:  npm run db:seed        (usa --force para repetirlo si ya hay usuarios)
require('dotenv').config();
const bcrypt = require('bcryptjs');
const db = require('../src/db');

const PASS = 'Demo2026*';   // misma contraseña de demostración del front

(async () => {
  const [[{ n }]] = await db.query('SELECT COUNT(*) AS n FROM usuarios');
  if (n > 0 && !process.argv.includes('--force')) {
    console.log('Ya hay usuarios cargados. Usa "node scripts/seed.js --force" para volver a sembrar.');
    return process.exit(0);
  }
  if (n > 0) {
    await db.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const t of ['notificaciones', 'auditoria', 'historico', 'evaluaciones', 'galpones', 'unidad_especies', 'unidades', 'usuarios'])
      await db.query(`TRUNCATE TABLE ${t}`);
    await db.query('SET FOREIGN_KEY_CHECKS = 1');
  }

  const hash = await bcrypt.hash(PASS, 10);
  const usuarios = [
    [1, 'Andrés Felipe', 'Rojas Medina',     'CC 1.010.000.001',  'admin@demo.co',        '300 000 0001', 'ADMIN', 'ACTIVO',    'Nivel central',         null, null],
    [2, 'Luz Marina',    'Cárdenas Pinzón',  'CC 1.010.000.002',  'coordinadora@demo.co', '300 000 0002', 'COORD', 'ACTIVO',    'Seccional Cundinamarca', null, null],
    [3, 'Camilo Andrés', 'Peña Rincón',      'CC 1.010.000.003',  'inspector@demo.co',    '300 000 0003', 'INSP',  'ACTIVO',    'Seccional Cundinamarca', null, null],
    [4, 'Daniela',       'Torres Bermúdez',  'CC 1.010.000.004',  'consultora@demo.co',   '300 000 0004', 'CONS',  'ACTIVO',    null,                    null, '2026-12-31'],
    [5, 'Hernán Darío',  'Mejía Ortiz',      'NIT 900.000.000-0', 'productor@demo.co',    '300 000 0005', 'PROD',  'ACTIVO',    null,                    null, null],
    [6, 'Rosa Elena',    'Quintero de Ávila','CC 1.010.000.006',  'tenedora@demo.co',     '310 000 0006', 'TEN',   'ACTIVO',    null,                    null, null],
    [7, 'Jorge Iván',    'Salazar Gómez',    'CC 1.010.000.007',  'tecnico@demo.co',      '300 000 0007', 'RT',    'ACTIVO',    null,                    'MVZ 00000 · vigente', null],
    [8, 'Usuario',       'Nuevo Sin Historial','CC 1.010.000.008','nuevo@demo.co',        '300 000 0008', 'INSP',  'PENDIENTE', 'Seccional Tolima',      null, null]
  ];
  for (const u of usuarios)
    await db.query(
      `INSERT INTO usuarios (id, nombres, apellidos, doc, correo, tel, rol, estado, seccional, matricula, vence, password_hash, extra)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [...u, hash, JSON.stringify({ historial: ![4, 8].includes(u[0]) })]);   // como en el prototipo: sin historial el consultor y el usuario nuevo

  await db.query(`INSERT INTO unidades (id, nombre, codigo, propietario_id, operario, rt_id, capacidad, gab, gab_vence, depto, mun, vereda, dir, indic, coord_sis, lat, lon) VALUES
    (1,'Granja Demostración','Por definir',5,'Administrador de ejemplo',7,45000,1,'2027-03-31','Cundinamarca','Silvania','Vereda de ejemplo','Km 5 vía de ejemplo','','GEO',4.4031,-74.3880),
    (2,'Granja Las Palmas','Por definir',5,'Operario de ejemplo',7,12000,1,'2026-11-05','Santander','Lebrija','Vereda de ejemplo','','Después de la escuela, 2 km','POLAR',NULL,NULL),
    (3,'Predio La Esperanza','—',6,'La misma tenedora',NULL,60,0,NULL,'Cundinamarca','Fusagasugá','Vereda San Isidro','','Junto a la escuela, dos curvas arriba','GEO',4.3372,-74.3638)`);

  await db.query(`INSERT INTO unidad_especies (unidad_id, sis, pastoreo) VALUES
    (1,'POLLO_ENGORDE',0),(2,'PONEDORA_PISO',1),(3,'TRAS_PONEDORA',0),(3,'TRAS_POLLO',0)`);

  await db.query(`INSERT INTO galpones (unidad_id, cod, tipo, area, beb, com, ref_b, ref_c, ext, patio, aves, edad, edad_unidad, grupo) VALUES
    (1,'G-01','TUNEL',1000,1400,300,12,45,0,0,14700,42,'días','Finalización (22 días – salida)'),
    (1,'G-02','TUNEL',1000,1400,320,12,45,0,0,14820,35,'días','Finalización (22 días – salida)'),
    (1,'G-03','ABIERTO_MEC',1000,1300,300,12,45,0,0,14900,28,'días','Finalización (22 días – salida)'),
    (2,'P-01','ABIERTO',1100,900,260,12,45,1800,0,11800,40,'semanas','Producción (≥ 18 sem.)'),
    (3,'Corral 1','',8,2,2,0,0,0,20,24,40,'semanas','Gallinas ponedoras'),
    (3,'Patio','',2,1,1,0,0,0,0,14,6,'semanas','Pollos de engorde')`);

  await db.query(`INSERT INTO historico (codigo, unidad_id, fecha, total, g_mbr, g_mba, g_mbg) VALUES
    ('V-2024-0098',1,'2024-09-03',65.0,66,70,58),
    ('V-2025-0142',1,'2025-10-12',72.1,72,78,64),
    ('V-2025-0201',2,'2025-11-20',91.2,92,94,87),
    ('T-2025-0033',3,'2025-08-14',48.0,45,50,0),
    ('V-2026-0012',2,'2026-03-02',88.4,85,92,88),
    ('T-2026-0007',3,'2026-06-21',76.8,80,74.5,0)`);

  console.log(`Datos de demostración cargados. Contraseña de todos los usuarios: ${PASS}`);
  process.exit(0);
})().catch(e => { console.error('Error al sembrar:', e.message); process.exit(1); });
