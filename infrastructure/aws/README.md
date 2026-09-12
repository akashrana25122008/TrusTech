# AWS deployment (TrusTech)

Reference topology for the MASTER-ENGINEERING-DIRECTIVE deployment targets.

```
 Browser extension (MV3)
        │  runtime messaging (extension API)
        ▼
 Backend API — AWS Fargate (FastAPI/uvicorn)
        │                         │
        │ (TLS via ALB + ACM)     ├── AuthN: AWS IAM/API Gateway
        ▼                         ▼
 Privacy Firewall  ────────►  LLM / VLM gateway (per-tenant keys in Secrets Manager)
        │            (PII redaction before egress)
        ▼
 Storage: S3 (audit logs) + optional DynamoDB (task state)
```

## Components

| Layer            | AWS service                           | Notes                                  |
| ---------------- | ------------------------------------- | -------------------------------------- |
| Static UI        | S3 + CloudFront (or Caddy sidecar)    | Unpacked extension served for install  |
| API              | ECS Fargate (ECR image)               | `docker/backend.Dockerfile`            |
| Config           | AWS Secrets Manager                   | API keys, never in the repo            |
| State            | DynamoDB (task/step ledger)           | Optional in later phases               |
| Audit            | S3 + simple log queue                 | Privacy firewall decisions             |
| Delivery         | GitHub Actions → ECR push → Fargate   | Tagged model/`backend` deploy          |

## Security guardrails

- WAF on the ALB: block non-`/api/*` traffic client-side, rate-limit.
- IAM: ECS task role `ecs:TagResource`, read-only Secrets Manager for the model
  gateway key, and nothing else.
- The extension runs trusted, human-gated actions **locally**; the backend
  never receives PII (see `extension/src/privacy/` and `backend/app/privacy/`).

## Deploy (terraform sketch)

See `main.tf` for a working skeleton. Real usage:

```bash
terraform init
terraform plan -var-file=environments/prod.tfvars
terraform apply
```

> Keep the `main.tf` portable; service names come from variables.