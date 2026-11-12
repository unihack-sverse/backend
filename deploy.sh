#!/bin/bash

cd /data/docker/sverse/backend/

echo "Pulling latest image..."
sudo docker-compose pull

echo "Recreating containers..."
sudo docker-compose up -d