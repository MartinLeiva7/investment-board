# Patrimonio Total Unificado (Unified Wealth Dashboard)

Un dashboard de control patrimonial unificado y consolidado de alto rendimiento y bajo consumo, diseñado específicamente para correr eficientemente en VPS de recursos limitados (como Oracle Micro) sin bundlers pesados, utilizando Node.js, Express y SQLite como base de datos local.

---

## ✨ Características Principales

1. **Importador Inteligente IOL:** Permite copiar y pegar el historial de transacciones directamente desde la web de InvertirOnline. Detecta columnas automáticamente, limpia monedas, y utiliza un hash único (MD5) para evitar duplicar operaciones ya cargadas.
2. **Scraping Híbrido de Precios:**
   - **Yahoo Finance:** Para cotizaciones en tiempo real de acciones locales y CEDEARs.
   - **Rava Bursátil:** Extracción del tag `og:description` como fallback para bonos soberanos argentinos (AL30, GD30, etc.).
   - **CryptoYa API:** Cotización en tiempo real del Dólar Cripto (USDT/ARS) para conversiones automáticas.
3. **Integración Binance (Spot + Funding Wallet):** Consulta y consolidación automática de tenencias de criptomonedas utilizando firmas HMAC SHA256 (las llaves se guardan seguras en el servidor y no se exponen al cliente).
4. **Evolución Histórica:** Registros diarios tomados automáticamente por un cron job a las 18:00 hs (o forzados manualmente con un botón de captura).
5. **Simulador de Interés Compuesto:** Proyección a futuro client-side con controles deslizantes e interactivos.
6. **Seguridad Nativa:** Bloqueo de acceso mediante contraseña usando HTTP Basic Auth a nivel Express (configurable por variable de entorno `.env` o desde los Ajustes de la interfaz).
7. **Diseño Premium:** Estética oscura, responsive y glassmorphism construida con Tailwind CSS, Lucide Icons y Chart.js.

---

## 🛠️ Instalación y Configuración Local

### Requisitos
- Node.js (versión 18 o superior recomendado)
- npm (gestor de paquetes)

### Pasos
1. Clona el repositorio e ingresa a la carpeta:
   ```bash
   git clone <URL_DE_TU_REPOSITORIO>
   cd investment-board
   ```
2. Instala las dependencias:
   ```bash
   npm install
   ```
3. Crea un archivo `.env` en la raíz (opcional pero recomendado para configurar el puerto y la contraseña):
   ```env
   PORT=3000
   DASHBOARD_PASSWORD=tu_contrasena_aqui
   ```
4. Inicia la aplicación:
   ```bash
   node server.js
   ```
5. Accede desde tu navegador en: [http://localhost:3000](http://localhost:3000)

---

## 🚀 Despliegue en VPS (Detalle de Producción)

Para correr la aplicación permanentemente en producción y de forma segura:

### 1. Administrador de Procesos (PM2)
Para evitar que la app se apague al cerrar la terminal:
```bash
sudo npm install -g pm2
pm2 start server.js --name "wealth-dashboard"
pm2 save
pm2 startup
```

### 2. Seguridad con HTTPS (Nginx + Let's Encrypt)
Se recomienda exponer la aplicación a través de un proxy inverso de Nginx configurando SSL (HTTPS) con Certbot para encriptar el tráfico de tus contraseñas y claves de API.

---

## 🔗 Convivencia con otras Webs en la misma VPS (Nginx)

Si ya tienes un juego web u otra aplicación corriendo en la misma VPS (por ejemplo, en `juego.duckdns.org`), **pueden convivir perfectamente en el mismo servidor Nginx**.

Nginx utiliza **Bloques de Servidor (Virtual Hosts)** y diferencia las peticiones según el dominio (`server_name`) al que acceda el usuario.

### Estructura de archivos de configuración en `/etc/nginx/`:

```
/etc/nginx/
├── sites-available/
│   ├── juego-web          <-- Tu configuración actual del juego (ej: puerto 8080)
│   └── wealth-dashboard   <-- Nueva configuración para el dashboard (puerto 3000)
```

### Pasos para configurar el Dashboard junto al Juego:

1. Crea el nuevo archivo de configuración para el dashboard:
   ```bash
   sudo nano /etc/nginx/sites-available/wealth-dashboard
   ```
2. Pega lo siguiente, definiendo el **nuevo subdominio** de DuckDNS asignado para tu portafolio (ej. `mi-patrimonio.duckdns.org`):
   ```nginx
   server {
       listen 80;
       server_name mi-patrimonio.duckdns.org;

       location / {
           proxy_pass http://localhost:3000; # Redirecciona al puerto de tu dashboard
           proxy_http_version 1.1;
           proxy_set_header Upgrade $http_upgrade;
           proxy_set_header Connection 'upgrade';
           proxy_set_header Host $host;
           proxy_cache_bypass $http_upgrade;
           proxy_set_header X-Real-IP $remote_addr;
           proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
           proxy_set_header X-Forwarded-Proto $scheme;
       }
   }
   ```
3. Habilita este nuevo bloque en Nginx creando un enlace simbólico:
   ```bash
   sudo ln -s /etc/nginx/sites-available/wealth-dashboard /etc/nginx/sites-enabled/
   ```
4. Prueba la sintaxis de Nginx para asegurarte de que no haya errores:
   ```bash
   sudo nginx -t
   ```
5. Si todo está correcto, recarga Nginx:
   ```bash
   sudo systemctl reload nginx
   ```
6. Instala el certificado SSL para el nuevo dominio con Certbot:
   ```bash
   sudo certbot --nginx -d mi-patrimonio.duckdns.org
   ```

Nginx dirigirá automáticamente a los usuarios que ingresen a `juego.duckdns.org` a la app de tu juego, y a los que ingresen a `mi-patrimonio.duckdns.org` a tu dashboard financiero de forma totalmente transparente e independiente.
