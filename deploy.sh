#!/bin/bash
# Pablo-päiväkirjan deploy: Cloud Run + Cloud Scheduler (illusian-pitch-processor)
set -euo pipefail
cd "$(dirname "$0")"

PROJECT=illusian-pitch-processor
REGION=europe-north1
SERVICE=pablo-tracker
source .env  # APP_TOKEN, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY

if [ -z "${APP_TOKEN:-}" ]; then
  echo "VIRHE: APP_TOKEN puuttuu .env-tiedostosta." >&2
  exit 1
fi

echo "==> Otetaan tarvittavat APIt käyttöön..."
gcloud services enable run.googleapis.com cloudbuild.googleapis.com \
  cloudscheduler.googleapis.com firestore.googleapis.com \
  --project=$PROJECT

echo "==> Deploy Cloud Runiin (buildaus pilvessä)..."
gcloud run deploy $SERVICE \
  --source=. \
  --project=$PROJECT \
  --region=$REGION \
  --allow-unauthenticated \
  --memory=256Mi \
  --min-instances=0 \
  --max-instances=2 \
  --set-env-vars="APP_TOKEN=$APP_TOKEN,VAPID_PUBLIC_KEY=$VAPID_PUBLIC_KEY,VAPID_PRIVATE_KEY=$VAPID_PRIVATE_KEY"

URL=$(gcloud run services describe $SERVICE --project=$PROJECT --region=$REGION --format='value(status.url)')
echo "==> Palvelu: $URL"

echo "==> Cloud Scheduler -muistutustarkistus 10 min välein..."
# Huom: Cloud Scheduler ei ole saatavilla europe-north1:ssä
SCHED_REGION=europe-west1
gcloud scheduler jobs delete pablo-reminders --project=$PROJECT --location=$SCHED_REGION --quiet 2>/dev/null || true
gcloud scheduler jobs create http pablo-reminders \
  --project=$PROJECT \
  --location=$SCHED_REGION \
  --schedule="*/10 * * * *" \
  --time-zone="Europe/Helsinki" \
  --uri="$URL/$APP_TOKEN/api/check-reminders" \
  --http-method=POST

echo ""
echo "✅ Valmis! Sovellus: $URL/$APP_TOKEN/"
