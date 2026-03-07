resource "digitalocean_spaces_bucket" "logbook_backups" {
  name   = var.bucket_name
  region = var.region
  acl    = var.bucket_acl

  versioning {
    enabled = true
  }
}

resource "digitalocean_spaces_key" "logbook_backups" {
  name = var.spaces_key_name

  grant {
    bucket     = digitalocean_spaces_bucket.logbook_backups.name
    permission = "readwrite"
  }
}
