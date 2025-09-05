# webapp-core — Infraestructura AWS con CDK (TypeScript)

Plantilla **modular y reutilizable** para aplicaciones web de **3 capas** en AWS. Prioriza **seguridad**, **alta disponibilidad (Multi-AZ)**, **rendimiento** y **observabilidad**, definida como **Infraestructura como Código** con **AWS CDK (TypeScript)** y parámetros en **.env**.

---

## Arquitectura (resumen)

**Clientes → CloudFront (+WAF/Shield)**
- `/assets/*` → **S3** privado con **OAC**, **BPA ON**, **Versioning**, **SSE-KMS (CMK)**.
- `/api/*` → **ALB** (público, restringido a CloudFront) → **ECS Fargate** (privado) → **RDS** (BD) / **Redis** (caché).

**Conectividad privada (VPCe)**: ECR API/DKR, Secrets Manager y CloudWatch Logs desde subred privada (sin salir a Internet).  
**Red**: Subredes públicas (ALB+NAT), privadas de app (ECS), y aisladas de datos (RDS/Redis), **todas en Multi-AZ**.  
**Observabilidad**: CloudWatch Logs/Metrics/Alarms.  
**Auth (opcional)**: Amazon Cognito (User Pool + App Client).

> **CloudFront Behaviors predefinidos**  
> - `/assets/*` → S3 (TLS ≥1.2, HSTS, cache estático).  
> - `/api/*` → ALB (TLS ≥1.2, HSTS, **sin caché**, forward `Authorization`, `Host`, query strings, cabecera `X-Origin-Verify`, métodos `GET/POST/PUT`).

---

## Estructura del repositorio

```
webapp-core/
├── bin/
│   └── app.ts              # punto de entrada CDK
├── lib/
│   ├── network-stack.ts
│   ├── database-stack.ts
│   ├── ecs-stack.ts
│   ├── frontend-stack.ts
│   ├── auth-stack.ts
│   └── ecr-stack.ts
├── .env                    # variables del proyecto (crea desde .env.example)
├── .env.example
├── cdk.json
├── package.json
├── package-lock.json
└── tsconfig.json
```

---

## Requisitos

### AWS y CLI
- Cuenta AWS con permisos para crear infraestructura (ideal: rol/admin IaC).
- **AWS CLI v2** configurado:
  ```bash
  aws configure
  # Access Key / Secret / region: us-east-1 / output: json
  ```

### Node.js, npm y AWS CDK
**Debian/Ubuntu**
```bash
sudo apt-get update && sudo apt-get install -y curl build-essential
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
source ~/.nvm/nvm.sh
nvm install 20
node -v && npm -v
npm install -g aws-cdk@2
cdk --version
```

**RHEL/CentOS/Alma/Rocky**
```bash
sudo dnf install -y curl gcc-c++ make
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
source ~/.nvm/nvm.sh
nvm install 20
node -v && npm -v
npm install -g aws-cdk@2
cdk --version
```

### Docker (para construir la imagen del backend)
**Debian/Ubuntu**
```bash
sudo apt-get install -y docker.io
sudo systemctl enable --now docker
sudo usermod -aG docker $USER
```

**RHEL/CentOS/Alma/Rocky**
```bash
sudo dnf install -y docker
sudo systemctl enable --now docker
sudo usermod -aG docker $USER
```

> Cierra y reabre sesión para aplicar el grupo `docker`.

---

## Configuración

Clona el repo e instala dependencias:
```bash
git clone <URL_DE_TU_REPO> webapp-core
cd webapp-core
npm install
```

Crea tu `.env` desde el ejemplo:
```bash
cp .env.example .env
nano .env
```

### `.env.example`
```dotenv
# Región y metadatos
AWS_REGION=us-east-1
PROJECT_NAME=webapp-core
VPC_CIDR=10.0.0.0/16
MAX_AZS=2

# Frontend (CloudFront + S3). Si aún no tienes dominio/certificado, deja vacío.
FRONTEND_DOMAIN=
FRONTEND_CERT_ARN=

# (Opcional) Dominio/cert para ALB/API. Si vacío, CloudFront -> ALB por HTTP interno.
BACKEND_DOMAIN=
BACKEND_CERT_ARN=

# RDS
DB_ENGINE=mysql                # mysql | postgres | aurora-mysql
DB_ENGINE_VERSION=8.0.28
DB_INSTANCE_CLASS=db.t3.micro  # mínimo para dev
DB_NAME=appdb
DB_USERNAME=admin              # la contraseña se genera en Secrets Manager

# ECS / ECR
ECR_REPO_NAME=webapp-core-app
ECS_DESIRED_COUNT=2
ECS_TASK_CPU=256               # 256=0.25 vCPU
ECS_TASK_MEMORY=512            # MB
ECS_CONTAINER_PORT=80
# Si ya tienes imagen, pon su URI (ECR o Docker Hub)
CONTAINER_IMAGE_URI=

# Cognito (opcional)
COGNITO_USER_POOL_NAME=webapp-core-users
COGNITO_APP_CLIENT_NAME=webapp-core-web

# ENV=dev
```

---

## Bootstrap de CDK (una sola vez por cuenta/región)

```bash
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
npx cdk bootstrap aws://$ACCOUNT_ID/us-east-1
```

---

## Despliegue recomendado (por etapas)

> Puedes desplegar todo con `npx cdk deploy --all`. Abajo el flujo sugerido con verificaciones.

### 1) Red y ECR
```bash
npx cdk deploy webapp-core-NetworkStack
npx cdk deploy webapp-core-ECRStack
```
Guarda el **ECR Repo URI** (salida del stack).

### 2) Construir y publicar imagen del backend
```bash
# Login en ECR
aws ecr get-login-password --region us-east-1 \
| docker login --username AWS --password-stdin $ACCOUNT_ID.dkr.ecr.us-east-1.amazonaws.com

# Build + push
docker build -t webapp-core-app:latest .
docker tag webapp-core-app:latest $ACCOUNT_ID.dkr.ecr.us-east-1.amazonaws.com/webapp-core-app:latest
docker push $ACCOUNT_ID.dkr.ecr.us-east-1.amazonaws.com/webapp-core-app:latest
```
Opcional: fija `CONTAINER_IMAGE_URI` en `.env` con la imagen empujada.

### 3) Base de Datos (RDS + Secret + KMS)
```bash
npx cdk deploy webapp-core-DatabaseStack
```
Outputs: endpoint de RDS y nombre del **Secret**.

### 4) Backend (ECS Fargate + ALB)
```bash
npx cdk deploy webapp-core-EcsStack
```
Verifica **Targets** del ALB en estado **healthy**.  
Output: **DNS del ALB** (origen `/api/*` en CloudFront).

### 5) Frontend (S3 + CloudFront + WAF)
```bash
npx cdk deploy webapp-core-FrontendStack
```
Outputs: **URL de CloudFront** (o tu dominio si configurado).

Sube el build del frontend al bucket:
```bash
aws s3 sync ./build/ s3://<TU_BUCKET_FRONTEND>/ --delete
aws cloudfront create-invalidation --distribution-id <DIST_ID> --paths "/*"
```

### 6) Autenticación (opcional, Cognito)
```bash
npx cdk deploy webapp-core-AuthStack
```
Outputs: `CognitoUserPoolId`, `CognitoUserPoolClientId`.

---

## Operación y pruebas

- **Acceso público**: URL de **CloudFront** (o tu dominio).
  - `/assets/*` → S3 cacheado en edge.
  - `/api/*` → ALB → ECS (**sin caché**), forward `Authorization`, `Host`, query strings, `X-Origin-Verify`.
- **Seguridad**:
  - S3 **privado** con **OAC**, **BPA ON**, **SSE** (KMS/CMK).
  - ALB solo acepta IN **desde CloudFront** (prefix list administrada).
  - RDS **no público**, subred aislada, **KMS**, conexión **TLS** desde app.
  - ECS sin IP pública, acceso a SM/ECR/Logs por **VPCe**.
  - **WAF** asociado a CloudFront (reglas administradas + rate-limit + regla custom header).
- **Observabilidad**:
  - Logs de contenedores en **CloudWatch Logs** (retención configurable).
  - Métricas ALB/ECS/RDS y alarmas en **CloudWatch**.
  - Health checks ALB (`/healthz`, HTTP 200).

---

## DNS y certificados

- **CloudFront**: certificados **siempre** en **us-east-1** (para dominios de CF).
- Si defines `FRONTEND_DOMAIN` y `FRONTEND_CERT_ARN`, crea CNAME/ALIAS en Route 53 hacia la distribución.
- **ALB**: certificado ACM **regional** (us-east-1). Si usas `BACKEND_DOMAIN`, crea CNAME al DNS del ALB (output).

---

## Comandos útiles

```bash
# Ver plantilla CloudFormation
npx cdk synth

# Comparar cambios
npx cdk diff

# Desplegar todos los stacks
npx cdk deploy --all

# Destruir todos (cuidado con RDS snapshots)
npx cdk destroy --all
```

---

## CI/CD (referencia rápida)

- **Backend**: build Docker → push a ECR.
- **Infra**: `npm ci` → `npx cdk diff` → `npx cdk deploy` (con entorno aprobado).
- **Frontend**: build → `aws s3 sync` → invalidación CloudFront.

> Recomendado: GitHub Actions con **OIDC** hacia AWS (evita Access Keys), o claves con **rotación** estricta.

---

## Costos y limpieza

- Los **NAT Gateways** (uno por AZ) tienen costo continuo. En dev puedes usar 1 AZ (menor HA, menor costo).  
- Limpieza: `npx cdk destroy` en orden inverso; **RDS** conserva snapshot por seguridad (puedes borrarlo manualmente si procede).

---

## 📜 License

This project is licensed under the **Apache License 2.0** - see the [LICENSE](LICENSE) file for details.

