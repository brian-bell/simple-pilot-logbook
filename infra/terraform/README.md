# Terraform Scaffold

This directory provisions the DigitalOcean Spaces resources needed by the
logbook backup worker:

- one Spaces bucket
- one Spaces access key scoped to that bucket with `readwrite` access

The runtime app does not depend on Terraform directly. Terraform is only used
to create and manage the cloud resources.

## Files

- `providers.tf`: Terraform and provider requirements
- `main.tf`: Spaces bucket and key resources
- `variables.tf`: input variables
- `outputs.tf`: values to feed into app configuration
- `terraform.tfvars.example`: starter variable file

## Usage

```powershell
cd infra/terraform
terraform init
terraform plan -out=tfplan
terraform apply tfplan
```

Copy the output values into the app environment variables:

- `spaces_bucket_name` -> `LOGBOOK_BACKUP_SPACES_BUCKET`
- `spaces_region` -> `LOGBOOK_BACKUP_SPACES_REGION`
- `spaces_endpoint` is the S3 endpoint the app derives from the region
- `spaces_access_key_id` -> `LOGBOOK_BACKUP_SPACES_KEY`
- `spaces_secret_access_key` -> `LOGBOOK_BACKUP_SPACES_SECRET`

## Notes

- The access key secret output is marked sensitive.
- `terraform.tfvars` is ignored by Git; use `terraform.tfvars.example` as a template.
- DigitalOcean Spaces is S3-compatible, so the app uploads with `boto3`.
