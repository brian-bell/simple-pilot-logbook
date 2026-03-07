variable "do_token" {
  description = "DigitalOcean API token used by Terraform."
  type        = string
  sensitive   = true
}

variable "bucket_name" {
  description = "Unique name for the backup Spaces bucket."
  type        = string
}

variable "region" {
  description = "DigitalOcean Spaces region."
  type        = string
  default     = "nyc3"
}

variable "bucket_acl" {
  description = "ACL for the Spaces bucket."
  type        = string
  default     = "private"
}

variable "spaces_key_name" {
  description = "Name for the Spaces access key Terraform creates."
  type        = string
  default     = "simple-pilot-logbook-backups"
}
