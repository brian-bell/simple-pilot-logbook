output "spaces_bucket_name" {
  description = "Bucket name for LOGBOOK_BACKUP_SPACES_BUCKET."
  value       = digitalocean_spaces_bucket.logbook_backups.name
}

output "spaces_region" {
  description = "Region for LOGBOOK_BACKUP_SPACES_REGION."
  value       = digitalocean_spaces_bucket.logbook_backups.region
}

output "spaces_endpoint" {
  description = "S3-compatible endpoint for the Spaces bucket."
  value       = "https://${digitalocean_spaces_bucket.logbook_backups.region}.digitaloceanspaces.com"
}

output "spaces_access_key_id" {
  description = "Access key ID for LOGBOOK_BACKUP_SPACES_KEY."
  value       = digitalocean_spaces_key.logbook_backups.access_key
  sensitive   = true
}

output "spaces_secret_access_key" {
  description = "Secret key for LOGBOOK_BACKUP_SPACES_SECRET."
  value       = digitalocean_spaces_key.logbook_backups.secret_key
  sensitive   = true
}
