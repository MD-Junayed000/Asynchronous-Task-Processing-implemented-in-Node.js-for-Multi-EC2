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

---

## File Descriptions

- **index.js**

  - Sets up Express + EJS views + static assets
  - Connects to Redis for `HSET` and `PUBLISH` on `task_updates`
  - Connects to RabbitMQ, declares `tasks` queue & DLX
  - `POST /` enqueues new tasks and (for quick tasks) polls Redis for results to render inline

- **worker.js**

  - Connects to RabbitMQ, prefetches 1 message per worker
  - `consume('tasks')`, for each message:

    1. Publish `started` to Redis pub/sub
    2. Run handler from `tasks.js`
    3. HSET final `status` & `result`
    4. Publish `completed`/`failed`
    5. Ack or retry/nack according to attempts
    6. Check queue length and publish on `queue_length`

- **tasks.js**

  - `send_email_task`, `reverse_text_task`, `fake_sentiment_analysis`
  - Each simulates work with a `sleep(500)`
  - Reverse and sentiment return quick results for inline display

- **views/index.ejs**

  - Bootstrap‑based form layout
  - Shows inline results for quick tasks
  - (Live Chart removed—results now static)

- **docker-compose.yml**

  - Services: `api`, `worker`, `rabbitmq`, `redis`, `redis-commander`
  - Declares dependencies and port mappings

- **Dockerfile**

  - `FROM node:18-alpine`, installs dependencies, copies code

---

## Prerequisites

- Docker & Docker Compose
- Node.js (for local development without Docker)

## Installation

1. **Clone repository**

   ```bash
   git clone https://github.com/MD-Junayed000/Async_task_node.js.git
   cd Async_task_node.js
   ```

2. **Build & start services**

   ```bash
   docker-compose up --build
   ```

3. **Access UIs**

   - API + UI: `http://localhost:5000`
   - RabbitMQ Management: `http://localhost:15672` (user: `guest`)
   - Redis Commander: `http://localhost:8081`

## Poridhi Lab Setup

1. Access the application through load balancer:
   At first load the system following the instructions as in local machine and checking if all the ports are forwarded!![image](https://github.com/user-attachments/assets/c154f7d6-4b58-4e79-a5ba-7261f1689b54)

2. Configure IP and port:

- Get IP from eth0 using `ifconfig`

<div align="center">
  <img src="https://github.com/user-attachments/assets/c007ea7b-90ba-4270-a214-0e7b24545a1a" alt="WhatsApp Image 2025-06-03 at 15 58 00_f2d59dd0" width="600">
</div>

- Use application port from Dockerfile

3. Create load balancer and configure with your application's IP and port in Poridhi lab:

<div align="center">
  <img src="https://github.com/user-attachments/assets/5b7681e6-ec05-4945-9663-ca0e0c32842e" alt="Screenshot 2025-06-03 155900" width="600">
</div>

![image](https://github.com/user-attachments/assets/f7786750-1b00-4e37-86a1-34744d5b7cb4)

## Appication

### 1. Navigate to `http://localhost:5000` in your browser.

Fill out any form:

- **Send Email** (will simulate success/failure)
- **Reverse Text** (quick result embedded)
- **Sentiment Analysis** (quick result embedded)

Domain name for a load balancer in the Poridhi lab environment (For 5000 port):https://67aa3ccddb2c69e7e975ceff-lb-803.bm-southeast.lab.poridhi.io/

![Screenshot 2025-06-03 192518](https://github.com/user-attachments/assets/6054e0c2-23f9-4f16-8fd2-e99298c52616)

### 2. Inspect live task state in Redis Commander under keys `task:<id>`.

Open the load balancer for port 5555 in the poridhi lab environment:https://67aa3ccddb2c69e7e975ceff-lb-751.bm-southeast.lab.poridhi.io/tasks

![image](https://github.com/user-attachments/assets/f018bf32-e32a-42cf-8672-6b492db58410)

- View task history, retries, failures
- Inspect live workers and system load

### 3. Inspect RabbitMQ queue depth in RabbitMQ Management UI.

Default credentials: guest/guest
-Monitor queues, exchanges, consumers and connections
![image](https://github.com/user-attachments/assets/5375b2ff-f01a-478a-9cd2-cffac62e59f4)
![image](https://github.com/user-attachments/assets/11458d9d-66eb-4369-967d-063da81fd392)
![image](https://github.com/user-attachments/assets/cb7b51fe-828b-486a-a5ab-6a833489e338)

![image](https://github.com/user-attachments/assets/570f3c0a-2b6c-44eb-ad65-3ec81ae757ee)

## Scaling Workers

To run multiple workers for parallel processing:

```bash
docker-compose up --scale worker=4
```

Each of the 4 worker containers will `prefetch(1)` message at a time. RabbitMQ round‑robins tasks to each **idle** worker. If one worker dies or crashes, its unacknowledged message is automatically requeued.
