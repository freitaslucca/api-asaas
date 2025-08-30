// app.js
import Fastify from 'fastify';
import fetch from 'node-fetch';

const app = Fastify({ logger: true });

const ASAAS_BASE_URL = process.env.ASAAS_BASE_URL || 'https://api-sandbox.asaas.com/v3';
const ASAAS_API_KEY = process.env.ASAAS_API_KEY; // sandbox key
const WEBHOOK_SHARED_TOKEN = process.env.ASAAS_WEBHOOK_TOKEN; // mesmo token cadastrado no painel/endpoint do webhook

function asaasHeaders() {
  return {
    'Content-Type': 'application/json',
    'access_token': ASAAS_API_KEY, // autenticação Asaas
  };
}

/**
 * 1) Criar Cliente
 */
app.post('/api/asaas/customers', async (req, reply) => {
  try {
    const body = req.body;
    const r = await fetch(`${ASAAS_BASE_URL}/customers`, {
      method: 'POST',
      headers: asaasHeaders(),
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!r.ok) return reply.code(r.status).send(data);
    return reply.send(data);
  } catch (err) {
    req.log.error(err);
    return reply.code(500).send({ error: 'customer_create_failed' });
  }
});

/**
 * 2) Criar Assinatura Mensal (PIX/BOLETO/CARTÃO)
 */
app.post('/api/asaas/subscriptions', async (req, reply) => {
  try {
    const {
      customer,
      value = 99.9,
      billingType = 'PIX',   // "PIX" | "BOLETO" | "CREDIT_CARD"
      cycle = 'MONTHLY',
      description = 'Plano Premium SaaS',
      nextDueDate,
      creditCard,
      creditCardHolderInfo,
    } = req.body;

    const payload = { customer, value, billingType, cycle, description, nextDueDate };

    if (billingType === 'CREDIT_CARD' && (creditCard || creditCardHolderInfo)) {
      payload['creditCard'] = creditCard;
      payload['creditCardHolderInfo'] = creditCardHolderInfo;
    }

    const r = await fetch(`${ASAAS_BASE_URL}/subscriptions`, {
      method: 'POST',
      headers: asaasHeaders(),
      body: JSON.stringify(payload),
    });
    const data = await r.json();
    if (!r.ok) return reply.code(r.status).send(data);
    return reply.send(data);
  } catch (err) {
    req.log.error(err);
    return reply.code(500).send({ error: 'subscription_create_failed' });
  }
});

/**
 * 2.1) Criar Assinatura Mensal no CARTÃO (rota dedicada)
 */
app.post('/api/asaas/subscriptions/card', async (req, reply) => {
  try {
    const {
      customer,
      value,
      cycle = 'MONTHLY',
      description = 'Plano Mensal SaaS',
      nextDueDate,
      creditCard,
      creditCardHolderInfo
    } = req.body;

    if (!customer || !value || !nextDueDate || !creditCard || !creditCardHolderInfo) {
      return reply.code(400).send({ error: 'missing_required_fields' });
    }

    const payload = {
      customer,
      value,
      cycle,
      description,
      nextDueDate,
      billingType: 'CREDIT_CARD',
      creditCard,
      creditCardHolderInfo
    };

    const r = await fetch(`${ASAAS_BASE_URL}/subscriptions`, {
      method: 'POST',
      headers: asaasHeaders(),
      body: JSON.stringify(payload),
    });
    const data = await r.json();
    if (!r.ok) return reply.code(r.status).send(data);
    return reply.send(data);
  } catch (err) {
    req.log.error(err);
    return reply.code(500).send({ error: 'subscription_card_create_failed' });
  }
});

/**
 * 2.2) Criar Pagamento ANUAL via PIX (cobrança única)
 */
app.post('/api/asaas/payments/pix', async (req, reply) => {
  try {
    const { customer, value, dueDate, description = 'Plano Anual SaaS' } = req.body;

    if (!customer || !value || !dueDate) {
      return reply.code(400).send({ error: 'missing_required_fields' });
    }

    const payload = { customer, billingType: 'PIX', value, dueDate, description };

    const r = await fetch(`${ASAAS_BASE_URL}/payments`, {
      method: 'POST',
      headers: asaasHeaders(),
      body: JSON.stringify(payload),
    });
    const data = await r.json();
    if (!r.ok) return reply.code(r.status).send(data);
    return reply.send(data);
  } catch (err) {
    req.log.error(err);
    return reply.code(500).send({ error: 'pix_payment_create_failed' });
  }
});

/**
 * 3) Webhook de eventos do Asaas
 */
app.post('/webhooks/asaas', async (req, reply) => {
  try {
    // 1) Segurança
    const token = req.headers['asaas-access-token'];
    if (WEBHOOK_SHARED_TOKEN && token !== WEBHOOK_SHARED_TOKEN) {
      return reply.code(401).send({ error: 'invalid_webhook_token' });
    }

    // 2) Idempotência (exemplo simples): use o event.id do Asaas se disponível
    const eventId = req.body?.id || `${req.body?.event}-${req.body?.payment?.id || 'none'}`;
    // TODO: verifique numa tabela "processed_events" e ignore se já processado
    // await db.events.ensureNotProcessed(eventId);

    const event = req.body?.event;          // e.g. "PAYMENT_RECEIVED"
    const payment = req.body?.payment;      // objeto de pagamento do Asaas
    if (!payment?.customer) {
      // payload inesperado — apenas loga
      req.log.warn({ body: req.body }, 'Webhook sem customer no payment');
      return reply.code(200).send({ ok: true });
    }

    // 3) Diferenciar assinatura mensal x anual à vista
    const isSubscription = Boolean(payment.subscription); // true = mensal (recorrente no cartão/PIX); false = anual (PIX avulso)

    // 4) Datas úteis
    const todayISO = new Date().toISOString().slice(0,10); // YYYY-MM-DD
    const dueDate = payment.dueDate || todayISO;

    // 5) Regras
    if (event === 'PAYMENT_RECEIVED') {
      // Exemplo: calcular validade
      const addDays = (dateStr, days) => {
        const d = new Date(dateStr + 'T00:00:00');
        d.setDate(d.getDate() + days);
        return d.toISOString().slice(0,10);
      };

      const expiresAt = isSubscription
        ? addDays(dueDate, 30)   // mensal: +30 dias
        : addDays(dueDate, 365); // anual: +365 dias

      // TODO: atualizar seu usuário/tenant como ATIVO até expiresAt
      // await db.users.setSubscriptionStatus(payment.customer, { status: 'ATIVO', expiresAt, lastPaymentId: payment.id });

      req.log.info({ customer: payment.customer, isSubscription, expiresAt }, 'Acesso liberado');
    }

    if (event === 'PAYMENT_OVERDUE' || event === 'PAYMENT_DELETED' || event === 'PAYMENT_REFUND_RECEIVED') {
      // TODO: suspender ou alertar
      // await db.users.setSubscriptionStatus(payment.customer, { status: 'INADIMPLENTE', lastPaymentId: payment.id });
      req.log.info({ customer: payment.customer, event }, 'Acesso suspenso/alerta');
    }

    // 6) Marcar idempotência como concluída
    // await db.events.markProcessed(eventId);

    return reply.code(200).send({ ok: true });
  } catch (err) {
    req.log.error(err);
    return reply.code(500).send({ error: 'webhook_processing_failed' });
  }
});

/**
 * 4) Utilidades
 */
// Listar cobranças de uma assinatura
app.get('/api/asaas/subscriptions/:id/payments', async (req, reply) => {
  try {
    const { id } = req.params;
    const r = await fetch(`${ASAAS_BASE_URL}/subscriptions/${id}/payments`, {
      method: 'GET',
      headers: asaasHeaders(),
    });
    const data = await r.json();
    if (!r.ok) return reply.code(r.status).send(data);
    return reply.send(data);
  } catch (err) {
    req.log.error(err);
    return reply.code(500).send({ error: 'subscription_payments_list_failed' });
  }
});

// Consultar uma cobrança
app.get('/api/asaas/payments/:id', async (req, reply) => {
  try {
    const { id } = req.params;
    const r = await fetch(`${ASAAS_BASE_URL}/payments/${id}`, {
      method: 'GET',
      headers: asaasHeaders(),
    });
    const data = await r.json();
    if (!r.ok) return reply.code(r.status).send(data);
    return reply.send(data);
  } catch (err) {
    req.log.error(err);
    return reply.code(500).send({ error: 'payment_get_failed' });
  }
});

app.get('/health', async () => ({ ok: true }));

const start = async () => {
  const port = process.env.PORT || 3000;
  try {
    if (!ASAAS_API_KEY) throw new Error('Missing ASAAS_API_KEY');
    await app.listen({ port, host: '0.0.0.0' });
    app.log.info(`API up on :${port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};
start();