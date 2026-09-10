{{/*
The object name.

`fullnameOverride` first, because the deployed objects, the Vault paths and the hostname all
name this service once and must agree. Without it the release-plus-chart form rendered
`onramp-adapter-service-onramp-adapter-service`, since the release is conventionally named after
the chart.
*/}}
{{- define "onramp.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else if contains .Chart.Name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{/*
The image reference.

`image.tag` is required. It used to fall back to `.Chart.AppVersion`, and an overlay that leaves
the tag unset rendered `:0.1.0`, a tag `reusable-build-images.yml` never pushes (it publishes
`YYYYmmdd-HHMMSS-<sha8>`, the shape a promotion tool's tag filter matches, or an explicit tag from
`workflow_dispatch`). Any deploy landing before the tag was set therefore pulled a nonexistent
image and the pod sat in `ImagePullBackOff`. Failing the render moves that from a runtime symptom
to a deploy-time error naming the cause.
*/}}
{{- define "onramp.image" -}}
{{- if not .Values.image.tag -}}
{{- fail "image.tag is empty: the deploy pipeline must supply it (a promotion tool sets it on the deployment it promotes; use `--set image.tag=<tag>` for a local render). The chart's appVersion is not a tag the build workflow publishes, so falling back to it renders an image that does not exist." -}}
{{- end -}}
{{- printf "%s:%s" .Values.image.repository .Values.image.tag -}}
{{- end -}}
{{/*
The service account this pod runs as: the one we create, or one the operator names.
*/}}
{{- define "onramp.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "onramp.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}
