# Bake targets for the onramp image. This file defines the deployable target,
# its build args and its labels.
#
# The tags, the layer cache (`type=gha`) and the SBOM/provenance attestations are
# supplied by `.github/workflows/reusable-build-images.yml` with `--set`, because
# only CI has the release tag and the Actions cache to write to. A local
# `docker buildx bake` gets neither, which is intended: a local build is not a
# publishable artefact.
variable "VCS_REF" { default = "main" }
variable "BUILD_DATE" { default = "" }
variable "REGISTRY_PATH" { default = "ghcr.io/paritytech" }
variable "PROJECT_NAME" { default = "onramp-adapter-service" }
# Set by the build-images workflow from the release tag. CI always supplies it;
# a local `docker buildx bake` should pass one too, so the versioned tag is
# never an empty ":".
variable "VERSION" { default = "" }

group "default" {
  targets = ["app"]
}

target "app" {
  dockerfile = "Dockerfile"
  context    = "."
  args = {
    VCS_REF       = "${VCS_REF}"
    BUILD_DATE    = "${BUILD_DATE}"
    REGISTRY_PATH = "${REGISTRY_PATH}"
    PROJECT_NAME  = "${PROJECT_NAME}"
  }
  # The immutable tag only. `:latest` was dropped: a promotion tool selects a
  # specific tag it has seen, so a mutable one is a tag nothing selects and an image an operator
  # can be surprised by. The workflow overrides this list anyway; it is set here so the file does
  # not describe a publishing behaviour the pipeline no longer has.
  tags = [
    "${REGISTRY_PATH}/${PROJECT_NAME}:${VERSION}",
  ]
}