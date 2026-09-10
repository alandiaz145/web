# Repost Club — V1

Aplicación de colaboración por puntos para publicaciones recientes.

## Incluido

- Registro e inicio de sesión.
- 50 puntos iniciales por usuario.
- Una campaña activa por usuario.
- Campañas con vencimiento automático a las 24 horas.
- Acciones: like, comentario, repost y mención.
- Costos por acción: like 1 PT, comentario 2 PT, repost 3 PT, mención 3 PT.
- Reserva de puntos al crear la campaña.
- Devolución automática de puntos no utilizados al vencer.
- Feed de campañas activas.
- Prevención de auto-colaboración y doble cobro por acción.
- Historial contable de movimientos.
- Comentarios marcados como `automatic` para futura verificación mediante Instagram API/webhooks.
- Likes, reposts y menciones en modo `trust` hasta integrar verificación oficial disponible.

## Stack

- GitHub: código fuente.
- Cloudflare Workers Static Assets: frontend + API en el mismo despliegue.
- Cloudflare D1: usuarios, sesiones, campañas, acciones y puntos.
- HTML/CSS/JavaScript sin framework para mantener la V1 liviana.

## Despliegue

1. Instalar dependencias: `npm install`.
2. Crear D1: `npm run db:create`.
3. Copiar el `database_id` generado y reemplazar `REPLACE_WITH_D1_DATABASE_ID` en `wrangler.toml`.
4. Crear tablas: `npm run db:migrate:remote`.
5. Publicar: `npm run deploy`.

Para desarrollo local: ejecutar primero `npm run db:migrate:local` y luego `npm run dev`.

## Próxima etapa

1. OAuth de Meta para asociar la cuenta web con Instagram profesional.
2. Guardar Instagram User ID además del username.
3. Webhook de comentarios para acreditar `comment` automáticamente.
4. Verificación de menciones/reposts cuando la API permita asociar la acción al usuario.
5. Panel admin para reportes, bloqueos y ajustes de puntos.
6. Ranking semanal y métricas de colaboración.

## Estado

Esta rama es una primera implementación aislada. No modifica el sitio `ALLEN KS` existente ni la rama principal del repositorio.
