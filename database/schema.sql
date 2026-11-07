-- =====================================================================
-- PlumaViva · Bienestar Aviar  ·  CAPA 3 (base de datos)
-- Motor: MySQL / MariaDB (XAMPP).  Importar desde phpMyAdmin o con:
--   mysql -u root < database/schema.sql
-- =====================================================================
CREATE DATABASE IF NOT EXISTS plumaviva CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE plumaviva;

-- (Opcional, recomendado) usuario propio en vez de root:
-- CREATE USER 'plumaviva'@'localhost' IDENTIFIED BY 'cambia_esta_clave';
-- GRANT ALL PRIVILEGES ON plumaviva.* TO 'plumaviva'@'localhost';

SET FOREIGN_KEY_CHECKS = 0;
DROP TABLE IF EXISTS codigos_2fa, recuperacion, notificaciones, auditoria, historico, evaluaciones, galpones, unidad_especies, unidades, usuarios, parametros;
SET FOREIGN_KEY_CHECKS = 1;

CREATE TABLE usuarios (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  nombres          VARCHAR(100) NOT NULL,
  apellidos        VARCHAR(100) NOT NULL,
  doc              VARCHAR(40)  NOT NULL,
  correo           VARCHAR(150) NULL UNIQUE,      -- obligatorio para crear/ingresar; nullable por datos heredados
  tel              VARCHAR(30),
  rol              ENUM('ADMIN','COORD','INSP','CONS','PROD','TEN','RT') NOT NULL,
  estado           ENUM('ACTIVO','INACTIVO','PENDIENTE') NOT NULL DEFAULT 'PENDIENTE',
  seccional        VARCHAR(80),
  matricula        VARCHAR(80),
  vence            DATE NULL,
  password_hash    VARCHAR(100) NOT NULL,
  debe_cambiar_password TINYINT(1) NOT NULL DEFAULT 0, -- 1 = clave temporal: obliga cambio al primer ingreso
  sesion_version   INT NOT NULL DEFAULT 0,          -- se incrementa al cambiar clave para invalidar sesiones anteriores
  intentos_fallidos TINYINT NOT NULL DEFAULT 0,
  bloqueado_hasta  DATETIME NULL,
  extra            LONGTEXT NULL,                 -- JSON: tipoDoc, rolPers, historial... (lo que el front guarda y no tiene columna)
  creado_en        TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE unidades (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  nombre        VARCHAR(150) NOT NULL,
  codigo        VARCHAR(40)  DEFAULT 'Por definir',
  propietario_id INT NOT NULL,
  operario      VARCHAR(150),
  rt_id         INT NULL,
  capacidad     INT NOT NULL DEFAULT 0,
  gab           TINYINT(1) NOT NULL DEFAULT 0,
  gab_vence     DATE NULL,
  depto         VARCHAR(60),
  mun           VARCHAR(80),
  vereda        VARCHAR(120),
  dir           VARCHAR(200),
  indic         VARCHAR(255),
  coord_sis     ENUM('GEO','POLAR') DEFAULT 'GEO',
  lat           DECIMAL(9,6) NULL,
  lon           DECIMAL(9,6) NULL,
  estado        ENUM('ACTIVA','INACTIVA') NOT NULL DEFAULT 'ACTIVA',
  extra         LONGTEXT NULL,                    -- JSON: inhab, movs, cambios (historial de la unidad)...
  creado_en     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (propietario_id) REFERENCES usuarios(id),
  FOREIGN KEY (rt_id)          REFERENCES usuarios(id)
) ENGINE=InnoDB;

CREATE TABLE unidad_especies (
  id        INT AUTO_INCREMENT PRIMARY KEY,
  unidad_id INT NOT NULL,
  sis       ENUM('POLLO_ENGORDE','PONEDORA_JAULA','PONEDORA_PISO','TRAS_PONEDORA','TRAS_POLLO') NOT NULL,
  pastoreo  TINYINT(1) NOT NULL DEFAULT 0,
  FOREIGN KEY (unidad_id) REFERENCES unidades(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE galpones (
  id        INT AUTO_INCREMENT PRIMARY KEY,
  unidad_id INT NOT NULL,
  cod       VARCHAR(40) NOT NULL,
  tipo      VARCHAR(20) DEFAULT '',
  area      DECIMAL(10,2) DEFAULT 0,
  beb       INT DEFAULT 0,
  com       INT DEFAULT 0,
  ref_b     INT DEFAULT 0,
  ref_c     INT DEFAULT 0,
  ext       DECIMAL(10,2) DEFAULT 0,
  patio     DECIMAL(10,2) DEFAULT 0,
  aves      INT DEFAULT 0,
  edad      INT DEFAULT 0,
  edad_unidad ENUM('días','semanas') DEFAULT 'días',
  grupo     VARCHAR(80),
  extra     LONGTEXT NULL,
  FOREIGN KEY (unidad_id) REFERENCES unidades(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Una evaluación guarda su cabecera en columnas y el detalle
-- (respuestas por indicador, galpones evaluados, grupos) en JSON.
CREATE TABLE evaluaciones (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  codigo     VARCHAR(30) NOT NULL UNIQUE,
  unidad_id  INT NOT NULL,
  sis        VARCHAR(20) NOT NULL,
  cap        ENUM('I','II') NOT NULL,          -- I = aves de corral, II = traspatio
  insp_id    INT NOT NULL,
  fecha      DATE NOT NULL,
  hora       VARCHAR(5) DEFAULT '08:00',
  estado     ENUM('BORRADOR','EN_PROCESO','FINALIZADA','VALIDADA','ANULADA','CERRADA') NOT NULL DEFAULT 'BORRADOR',
  orden      VARCHAR(10) DEFAULT 'MBR',
  pastoreo   TINYINT(1) DEFAULT 0,
  consent    TINYINT(1) DEFAULT 0,
  obs_gen    TEXT,
  detalle    LONGTEXT,                          -- JSON: { resp, galpones, grupos, inv, atiende, ... }
  validada_por INT NULL,
  validada_en  DATETIME NULL,
  creado_en  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  actualizado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (unidad_id) REFERENCES unidades(id),
  FOREIGN KEY (insp_id)   REFERENCES usuarios(id),
  FOREIGN KEY (validada_por) REFERENCES usuarios(id)
) ENGINE=InnoDB;

CREATE TABLE historico (
  id        INT AUTO_INCREMENT PRIMARY KEY,
  codigo    VARCHAR(30) NOT NULL UNIQUE,
  unidad_id INT NOT NULL,
  fecha     DATE NOT NULL,
  total     DECIMAL(5,1) NOT NULL,
  g_mbr     DECIMAL(5,1) DEFAULT 0,
  g_mba     DECIMAL(5,1) DEFAULT 0,
  g_mbg     DECIMAL(5,1) DEFAULT 0,
  cap       CHAR(2) NULL,
  sis       VARCHAR(20) NULL,
  det       LONGTEXT NULL,               -- JSON { indicador: porcentaje } para el plan de mejora histórico
  FOREIGN KEY (unidad_id) REFERENCES unidades(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE auditoria (
  id       INT AUTO_INCREMENT PRIMARY KEY,
  t        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  usuario_id INT NULL,
  rol      VARCHAR(10),
  usuario  VARCHAR(200),
  accion   VARCHAR(60) NOT NULL,
  objeto   VARCHAR(255) NOT NULL,
  modulo   VARCHAR(60),
  detalle  TEXT,                                -- JSON [{c, a, d}]
  motivo   VARCHAR(255),
  INDEX (t), INDEX (modulo)
) ENGINE=InnoDB;

-- Parametrización: pesos, niveles, muestreo... (un registro por clave, valor en JSON)
CREATE TABLE parametros (
  clave VARCHAR(40) PRIMARY KEY,
  valor LONGTEXT NOT NULL
) ENGINE=InnoDB;

-- Notificaciones del sistema (campana del front)
-- Enlaces de recuperación de contraseña (se guarda el hash, nunca el token en claro)
CREATE TABLE recuperacion (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  usuario_id INT NOT NULL,
  token_hash CHAR(64) NOT NULL,
  expira     DATETIME NOT NULL,
  usado      TINYINT(1) NOT NULL DEFAULT 0,
  creado_en  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX (token_hash),
  FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Códigos de verificación en dos pasos (se guarda el hash, nunca el código en claro)
CREATE TABLE codigos_2fa (
  id         CHAR(36) PRIMARY KEY,
  usuario_id INT NOT NULL,
  codigo_hash CHAR(64) NOT NULL,
  expira     DATETIME NOT NULL,
  usado      TINYINT(1) NOT NULL DEFAULT 0,
  intentos   TINYINT NOT NULL DEFAULT 0,
  creado_en  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX (usuario_id, usado, expira),
  FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE notificaciones (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  usuario_id INT NULL,                       -- quién la generó
  t          VARCHAR(400) NOT NULL,
  d          VARCHAR(10)  NOT NULL,          -- dd/mm, como lo muestra el front
  creado_en  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX (creado_en)
) ENGINE=InnoDB;

INSERT INTO parametros (clave, valor) VALUES
 ('pesos',    '{"I":{"MBA":35,"MBR":35,"MBG":30},"II":{"MBA":60,"MBR":40,"MBG":0}}'),
 ('niveles',  '[{"n":"EXCELENTE","min":90},{"n":"ALTO","min":75},{"n":"MEDIO","min":50},{"n":"BAJO","min":0}]'),
 ('muestreo', '{"puntos":9,"avesMin":15,"avesMax":30,"jaulasMin":3,"jaulasMax":5}'),
 ('tabla3',   '[{"hasta":50000,"galpones":1},{"hasta":null,"galpones":2}]'),
 ('imp',      '{}'),                                       -- importancia por indicador (plan de mejora)
 ('roles',    '{"roles":[],"perm":{},"siguiente":0}');     -- roles personalizados y ajustes de roles
