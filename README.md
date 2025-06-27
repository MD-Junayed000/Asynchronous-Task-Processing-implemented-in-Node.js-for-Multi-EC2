# Asynchronous Task Processing implemented in Node.js for Multi-EC2

A demonstration project showing how to offload work from an Express API into background workers using RabbitMQ, track progress in Redis, and stream live updates to the browser via Socket.IO.

## System Architecture :

<img src="assests/Node.svg" alt="Implementation Diagram" width="1000">

1. **Browser → Express**
   When you click any Tasks in the UI, the browser sends an HTTP POST to the Express API. This step simply accepts your form data and kicks off the asynchronous workflow; you don’t wait around in that HTTP connection for the work to finish.

2. **Express → Redis Pub/Sub**
   Immediately after receiving your request, the API writes a hash entry `task:<id> → status=pending` into Redis and publishes a `task_updates` message. This lets any subscriber (including your UI) know that the job is officially “in the queue.”
3. **Express → RabbitMQ**
   Next, the API serializes `{ id, type, payload }` and pushes it into the durable RabbitMQ `tasks` queue. This hands control over to the message broker, which will safely hold and distribute jobs to available workers.

4. **Redis Pub/Sub → Browser (via socket.io)**
   Express stays subscribed to Redis’s `task_updates` channel. Every time Redis emits an update, Express immediately re-broadcasts that event over WebSockets to the browser, so the user sees “pending” or “started” in real time without refreshing.

5. **RabbitMQ → Worker**
   RabbitMQ holds tasks until a worker connects. Each worker instance calls `ch.consume("tasks")`, pulls the next message, and invokes the appropriate handler in tasks.js (e.g. reverse text, sentiment analysis, send email).

<div align="center">
  <img src="assests/queue.svg" alt="Broker Diagram" width="700">
</div>

The worker is a standalone Node.js process (defined in worker.js) that continuously listens to the RabbitMQ tasks queue

**_Key Concepts_**

- prefetch(1)
  Ensures each worker only has one un-acked message at a time.

- Resilience
  If a worker crashes before ack/nack, RabbitMQ re-queues its un-acked message.

- Parallel Throughput
  With N workers, up to N tasks run in parallel, each one at a time.

- CPU & Scaling
  Node.js is single-threaded; launch multiple worker processes to utilize multiple cores.

- Dead-Lettering (DLX)
  Jobs that fail too many times end up in tasks.dlq for inspection.

6. **Worker → Redis Pub/Sub**
   As the worker processes a job, it publishes its own updates into Redis: first `{ status: "started" }`, then—upon completion or failure—writes `status` and `result` back into `task:<id>`, and publishes a final task_updates event. Failures are retried up to a limit, then dead‐lettered.

7. **Redis Pub/Sub → Browser (Socket.IO)**
   Express receives the worker’s `task_updates` messages and forwards them over WebSockets, updating the UI to reflect “started,” “completed,” or “failed” as soon as they occur.

> **Scale:** With `docker-compose up --scale worker=4`, you run 4 identical worker processes. RabbitMQ will distribute tasks round‑robin, and with `ch.prefetch(1)` each worker has at most **one** un‑acked message at a time.

## Client Interaction Flow

<img src="assests/show.svg" alt="Implementation Diagram" width="1000">

docker-compose.yml is optimized with profiles so each instance only spins up its assigned service:(Use profiles to isolate services)
```bash
version: "3.8"
services:
  api:
    build: .
    profiles: ["api"]
    command: npm run start
    ports:
      - "5000:5000"
    environment:
      RABBIT_URL: amqp://<RABBITMQ_IP>:5672
      REDIS_URL: redis://<REDIS_IP>:6379
    depends_on:
      - rabbitmq
      - redis

  worker:
    build: .
    profiles: ["worker"]
    command: npm run worker
    environment:
      RABBIT_URL: amqp://<RABBITMQ_IP>:5672
      REDIS_URL: redis://<REDIS_IP>:6379
    depends_on:
      - rabbitmq
      - redis

  rabbitmq:
    image: rabbitmq:3-management
    profiles: ["rabbitmq"]
    ports:
      - "5672:5672"
      - "15672:15672"

  redis:
    image: redis:7
    profiles: ["redis"]
    ports:
      - "6379:6379"

  redis-commander:
    image: rediscommander/redis-commander
    profiles: ["redisui"]
    ports:
      - "8081:8081"
    environment:
      REDIS_HOSTS: |
        local:<REDIS_IP>:6379
```

## Project Structure

```
async-node/
├── Dockerfile            # Node.js image definition
├── docker-compose.yml    # Multi-service setup
├── package.json          # NPM dependencies & scripts
├── index.js              # Express API + RabbitMQ producer + Redis pub/sub
├── worker.js             # RabbitMQ consumer + task execution + Redis updates
├── tasks.js              # Business logic task handlers
├── views/
│   └── index.ejs         # EJS template for forms & results
└── public/css/
    └── style.css         # Basic styling
```

