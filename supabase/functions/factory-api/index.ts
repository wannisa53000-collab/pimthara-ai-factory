
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json; charset=utf-8",
};

type JsonObject = Record<string, unknown>;

function jsonResponse(
  status: number,
  body: JsonObject,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: corsHeaders,
  });
}

function getString(
  value: unknown,
  maxLength: number,
): string {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLength);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "GET" && req.method !== "POST") {
    return jsonResponse(405, {
      ok: false,
      error: "METHOD_NOT_ALLOWED",
    });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const authorization = req.headers.get("Authorization");

  if (!supabaseUrl || !supabaseAnonKey) {
    return jsonResponse(500, {
      ok: false,
      error: "SERVER_CONFIGURATION_MISSING",
    });
  }

  if (!authorization?.startsWith("Bearer ")) {
    return jsonResponse(401, {
      ok: false,
      error: "AUTH_REQUIRED",
      message: "กรุณาเข้าสู่ระบบ Owner ก่อนเรียก API",
    });
  }

  // ใช้ JWT ของผู้เรียก API และให้ Supabase RLS ตรวจสิทธิ์
  // ห้ามใช้ Service Role Key ใน API สำหรับผู้ใช้ทั่วไป
  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    global: {
      headers: { Authorization: authorization },
    },
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  const { data: authData, error: authError } =
    await supabase.auth.getUser();

  if (authError || !authData.user) {
    return jsonResponse(401, {
      ok: false,
      error: "INVALID_SESSION",
    });
  }

  let input: JsonObject = {};

  if (req.method === "POST") {
    try {
      const rawBody = await req.text();

      if (rawBody.length > 20_000) {
        return jsonResponse(413, {
          ok: false,
          error: "REQUEST_TOO_LARGE",
        });
      }

      const parsed: unknown = JSON.parse(rawBody);

      if (
        !parsed ||
        typeof parsed !== "object" ||
        Array.isArray(parsed)
      ) {
        return jsonResponse(400, {
          ok: false,
          error: "INVALID_JSON_OBJECT",
        });
      }

      input = parsed as JsonObject;
    } catch {
      return jsonResponse(400, {
        ok: false,
        error: "INVALID_JSON",
      });
    }
  }

  const url = new URL(req.url);
  const action = getString(
    input.action ?? url.searchParams.get("action") ?? "status",
    80,
  );

  // ACTION 1: ตรวจสอบ API และการเชื่อมต่อฐานข้อมูล
  if (action === "status") {
    const { error: dbError } = await supabase
      .from("work_orders")
      .select("wo_id")
      .limit(1);

    if (dbError) {
      return jsonResponse(403, {
        ok: false,
        api: "PIMTHARA AI FACTORY API",
        version: "API-001",
        authenticated: true,
        database: "error",
        message: dbError.message,
      });
    }

    return jsonResponse(200, {
      ok: true,
      api: "PIMTHARA AI FACTORY API",
      version: "API-001",
      authenticated: true,
      database: "connected",
      ai_provider: "not_configured",
      capabilities: [
        "status",
        "list_work_orders",
        "list_workflows",
        "create_work_order",
      ],
    });
  }

  // ACTION 2: อ่าน Work Orders
  if (action === "list_work_orders") {
    const { data, error } = await supabase
      .from("work_orders")
      .select(
        "wo_id, title, work_type, requirement, priority, workflow_id, current_step, current_employee_id, status, version, created_at, updated_at",
      )
      .order("created_at", { ascending: false })
      .limit(100);

    if (error) {
      return jsonResponse(400, {
        ok: false,
        error: "WORK_ORDERS_QUERY_FAILED",
        message: error.message,
      });
    }

    return jsonResponse(200, {
      ok: true,
      count: data?.length ?? 0,
      data: data ?? [],
    });
  }

  // ACTION 3: อ่าน Workflow ที่เปิดใช้งาน
  if (action === "list_workflows") {
    const { data, error } = await supabase
      .from("workflow_templates")
      .select(
        "workflow_id, name, description, steps, version, active",
      )
      .eq("active", true)
      .order("workflow_id", { ascending: true });

    if (error) {
      return jsonResponse(400, {
        ok: false,
        error: "WORKFLOWS_QUERY_FAILED",
        message: error.message,
      });
    }

    return jsonResponse(200, {
      ok: true,
      count: data?.length ?? 0,
      data: data ?? [],
    });
  }

  // ACTION 4: สร้าง Work Order
  if (action === "create_work_order") {
    if (req.method !== "POST") {
      return jsonResponse(405, {
        ok: false,
        error: "POST_REQUIRED",
      });
    }

    const title = getString(input.title, 200);
    const workType = getString(input.work_type, 80);
    const requirement = getString(input.requirement, 8000);
    const workflowId = getString(input.workflow_id, 80);
    const requestedPriority = getString(
      input.priority ?? "NORMAL",
      20,
    ).toUpperCase();

    const allowedPriorities = [
      "LOW",
      "NORMAL",
      "HIGH",
      "URGENT",
    ];

    if (title.length < 3) {
      return jsonResponse(400, {
        ok: false,
        error: "INVALID_TITLE",
        message: "title ต้องมี 3–200 ตัวอักษร",
      });
    }

    if (!workType) {
      return jsonResponse(400, {
        ok: false,
        error: "INVALID_WORK_TYPE",
      });
    }

    if (!requirement) {
      return jsonResponse(400, {
        ok: false,
        error: "INVALID_REQUIREMENT",
      });
    }

    if (!workflowId) {
      return jsonResponse(400, {
        ok: false,
        error: "INVALID_WORKFLOW_ID",
      });
    }

    if (!allowedPriorities.includes(requestedPriority)) {
      return jsonResponse(400, {
        ok: false,
        error: "INVALID_PRIORITY",
        allowed: allowedPriorities,
      });
    }

    // ยืนยันว่า Workflow มีอยู่และเปิดใช้งาน
    const { data: workflow, error: workflowError } =
      await supabase
        .from("workflow_templates")
        .select("workflow_id, name, steps")
        .eq("workflow_id", workflowId)
        .eq("active", true)
        .maybeSingle();

    if (workflowError) {
      return jsonResponse(400, {
        ok: false,
        error: "WORKFLOW_LOOKUP_FAILED",
        message: workflowError.message,
      });
    }

    if (!workflow) {
      return jsonResponse(400, {
        ok: false,
        error: "WORKFLOW_NOT_FOUND_OR_INACTIVE",
      });
    }

    // คงรูปแบบเริ่มต้นให้สอดคล้องกับ Owner Login เดิม
    // การกำหนดนี้ยังไม่ใช่การส่งงานให้พนักงาน AI จริง
    const firstStep = "นัท";
    const firstEmployeeId = "EMP-002";

    const newWorkOrder = {
      command_id: crypto.randomUUID(),
      requester: authData.user.email ?? authData.user.id,
      title,
      work_type: workType,
      requirement,
      priority: requestedPriority,
      workflow_id: workflowId,
      current_step: firstStep,
      current_employee_id: firstEmployeeId,
      status: "QUEUED",
      version: 1,
    };

    const { data: created, error: insertError } =
      await supabase
        .from("work_orders")
        .insert(newWorkOrder)
        .select(
          "wo_id, command_id, title, work_type, priority, workflow_id, current_step, current_employee_id, status, version, created_at",
        )
        .single();

    if (insertError) {
      return jsonResponse(400, {
        ok: false,
        error: "WORK_ORDER_CREATE_FAILED",
        message: insertError.message,
      });
    }

    // ไม่เขียน work_order_events ในเวอร์ชันแรก
    // เพราะต้องตรวจสอบข้อกำหนด actor และโครงสร้างตารางก่อน
    return jsonResponse(201, {
      ok: true,
      message:
        "Work Order created. AI processing is not connected yet.",
      data: created,
      ai_dispatched: false,
      note:
        "การสร้างงานสำเร็จไม่ได้หมายความว่ามีการประมวลผลด้วย AI",
    });
  }

  return jsonResponse(400, {
    ok: false,
    error: "UNKNOWN_ACTION",
    allowed: [
      "status",
      "list_work_orders",
      "list_workflows",
      "create_work_order",
    ],
  });
});
