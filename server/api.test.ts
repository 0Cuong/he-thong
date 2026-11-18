import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { openDatabase } from './db.ts';
import { RealtimeHub } from './realtime.ts';
import { createApp } from './app.ts';

interface ApiClient {
  cookie: string;
  request(method: string, path: string, body?: unknown): Promise<{ status: number; data: any; headers: Headers }>;
}

function makeClient(baseUrl: string): ApiClient {
  let cookie = '';
  return {
    get cookie() {
      return cookie;
    },
    async request(method: string, path: string, body?: unknown) {
      const headers: Record<string, string> = {};
      if (cookie) headers['cookie'] = cookie;
      if (body !== undefined) headers['content-type'] = 'application/json';

      const res = await fetch(`${baseUrl}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) {
        cookie = setCookie.split(';')[0];
      }
      const contentType = res.headers.get('content-type') || '';
      const data = contentType.includes('application/json')
        ? await res.json()
        : Buffer.from(await res.arrayBuffer());
      return { status: res.status, data, headers: res.headers };
    },
  };
}

test('Full-stack Lớp 12A17 integration, concurrency, RBAC, scoring (max 10), and export suite', async () => {
  const db = openDatabase(':memory:');
  const realtime = new RealtimeHub();
  const app = createApp(db, realtime);
  const server = http.createServer(app);
  realtime.attach(server, db);

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    // 1. Auth & Disabled account check
    const teacher = makeClient(baseUrl);
    const badLogin = await teacher.request('POST', '/api/auth/login', {
      username: 'teacher01',
      password: 'wrong-password',
    });
    assert.equal(badLogin.status, 401);

    const okLogin = await teacher.request('POST', '/api/auth/login', {
      username: 'teacher01',
      password: 'Teacher@1234',
    });
    assert.equal(okLogin.status, 200);
    assert.equal(okLogin.data.user.role, 'TEACHER');

    // Verify 48 students seeded
    const usersRes = await teacher.request('GET', '/api/users?role=STUDENT&limit=100');
    assert.equal(usersRes.status, 200);
    assert.equal(usersRes.data.total, 48);

    // 2. Security: Student cannot access admin endpoints
    const hs48 = makeClient(baseUrl);
    const stuLogin = await hs48.request('POST', '/api/auth/login', {
      username: 'HS048',
      password: 'Student@123',
    });
    assert.equal(stuLogin.status, 200);
    assert.equal(stuLogin.data.user.role, 'STUDENT');

    const forbiddenAdmin = await hs48.request('GET', '/api/admin/overview');
    assert.equal(forbiddenAdmin.status, 403);
    const forbiddenUsers = await hs48.request('GET', '/api/users');
    assert.equal(forbiddenUsers.status, 403);

    // 3. Concurrency Race Test on LAST seat in Group 8 (currently 5/6 seats taken)
    // First create 10 extra students or use 5 unassigned students in a new test room with 1 seat
    const roomCreate = await teacher.request('POST', '/api/rooms', {
      classroomId: 'cls_12a17',
      name: 'Phòng Kiểm Thử Đồng Thời',
      roomCode: 'RACE-01',
      groupCount: 1,
      groupCapacity: 1,
    });
    assert.equal(roomCreate.status, 201);
    const raceRoomId = roomCreate.data.room.id;

    // Rubric update > 10 points must be rejected
    const badRubric = await teacher.request('PUT', `/api/rooms/${raceRoomId}/rubric`, {
      title: 'Rubric vượt thang',
      scoringMode: 'SUM',
      decimalPrecision: 2,
      criteria: [
        { name: 'Tiêu chí 1', minScore: 0, maxScore: 6, weight: 1 },
        { name: 'Tiêu chí 2', minScore: 0, maxScore: 6, weight: 1 },
      ],
    });
    assert.equal(badRubric.status, 400);

    await teacher.request('POST', `/api/rooms/${raceRoomId}/transition`, {
      targetStatus: 'REGISTRATION_OPEN',
    });
    const raceRoomDetail = await teacher.request('GET', `/api/rooms/${raceRoomId}`);
    const raceGroupId = raceRoomDetail.data.groups[0].id;

    // Log in 8 students concurrently and race for the single seat!
    const racers = await Promise.all(
      Array.from({ length: 8 }, async (_, idx) => {
        const c = makeClient(baseUrl);
        await c.request('POST', '/api/auth/login', {
          username: `HS${String(idx + 1).padStart(3, '0')}`,
          password: 'Student@123',
        });
        return c;
      })
    );

    const raceOutcomes = await Promise.all(
      racers.map((c) => c.request('POST', `/api/rooms/${raceRoomId}/groups/${raceGroupId}/join`))
    );
    const successes = raceOutcomes.filter((r) => r.status === 200);
    const conflicts = raceOutcomes.filter((r) => r.status === 409);
    assert.equal(successes.length, 1, 'Exactly 1 student must win the last available seat');
    assert.equal(conflicts.length, 7, 'Remaining 7 students must receive 409 capacity conflict');

    // 4. Live Scoring, Multi-Grader Independence, Idempotency, Corrections & Private Note Stripping
    const gkRoomId = 'room_gk_01';
    // HS048 joins Group 8 in room_gk_01
    const joinG8 = await hs48.request('POST', `/api/rooms/${gkRoomId}/groups/grp_gk01_8/join`);
    assert.equal(joinG8.status, 200);

    // Start room assessment (locks groups)
    const startRes = await teacher.request('POST', `/api/rooms/${gkRoomId}/transition`, {
      targetStatus: 'IN_PROGRESS',
    });
    assert.equal(startRes.status, 200);

    // Student cannot join after session started
    const lateJoin = await hs48.request('POST', `/api/rooms/${gkRoomId}/groups/grp_gk01_7/join`);
    assert.equal(lateJoin.status, 403);

    // Teacher saves draft then submits with idempotency key (max 10-point scale)
    const scoresPayload = [
      { criterionId: 'crit_gk01_1', score: 1.8 },
      { criterionId: 'crit_gk01_2', score: 1.7 },
      { criterionId: 'crit_gk01_3', score: 1.9 },
      { criterionId: 'crit_gk01_4', score: 1.3 },
      { criterionId: 'crit_gk01_5', score: 1.4 },
      { criterionId: 'crit_gk01_6', score: 0.9 },
    ]; // Total = 9

    const draftRes = await teacher.request('PUT', `/api/rooms/${gkRoomId}/groups/grp_gk01_1/assessment`, {
      scores: scoresPayload,
      comments: {
        publicFeedback: 'Nhóm thuyết trình mạch lạc, dẫn chứng tốt.',
        privateNotes: 'BÍ MẬT GIÁO VIÊN: HS002 cần theo dõi thêm.',
      },
    });
    assert.equal(draftRes.status, 200);
    assert.equal(draftRes.data.assessment.totalScore, 9);

    const idemKey = 'idem-submit-001';
    const submit1 = await teacher.request(
      'POST',
      `/api/rooms/${gkRoomId}/groups/grp_gk01_1/assessment/submit`,
      {
        idempotencyKey: idemKey,
        scores: scoresPayload,
        comments: {
          publicFeedback: 'Nhóm thuyết trình mạch lạc, dẫn chứng tốt.',
          privateNotes: 'BÍ MẬT GIÁO VIÊN: HS002 cần theo dõi thêm.',
        },
      }
    );
    assert.equal(submit1.status, 200);
    assert.equal(submit1.data.assessment.deduplicated, false);

    // Replay same idempotency key -> deduplicated without error
    const submitReplay = await teacher.request(
      'POST',
      `/api/rooms/${gkRoomId}/groups/grp_gk01_1/assessment/submit`,
      {
        idempotencyKey: idemKey,
        scores: scoresPayload,
        comments: {},
      }
    );
    assert.equal(submitReplay.status, 200);
    assert.equal(submitReplay.data.assessment.deduplicated, true);

    // Second Grader scores Group 1 independently (Total = 8) -> avg = 8.5
    const grader1 = makeClient(baseUrl);
    await grader1.request('POST', '/api/auth/login', {
      username: 'grader01',
      password: 'Grader@1234',
    });
    const g1Scores = [
      { criterionId: 'crit_gk01_1', score: 1.6 },
      { criterionId: 'crit_gk01_2', score: 1.6 },
      { criterionId: 'crit_gk01_3', score: 1.6 },
      { criterionId: 'crit_gk01_4', score: 1.2 },
      { criterionId: 'crit_gk01_5', score: 1.2 },
      { criterionId: 'crit_gk01_6', score: 0.8 },
    ];
    const g1Submit = await grader1.request(
      'POST',
      `/api/rooms/${gkRoomId}/groups/grp_gk01_1/assessment/submit`,
      {
        idempotencyKey: 'grader1-sub-1',
        scores: g1Scores,
        comments: { publicFeedback: 'Phần Q&A trả lời rõ ràng.' },
      }
    );
    assert.equal(g1Submit.status, 200);
    assert.equal(g1Submit.data.assessment.totalScore, 8);

    // Grader1 CANNOT modify Teacher's assessment
    const teacherAssessmentId = submit1.data.assessment.id;
    const hijackRes = await grader1.request(
      'POST',
      `/api/rooms/${gkRoomId}/assessments/${teacherAssessmentId}/correct`,
      {
        reason: 'Cố tình sửa điểm người khác',
        scores: g1Scores,
      }
    );
    assert.equal(hijackRes.status, 403);

    // Teacher corrects their own score with mandatory reason -> revision #2 created
    const correctedScores = [
      { criterionId: 'crit_gk01_1', score: 2 },
      { criterionId: 'crit_gk01_2', score: 1.7 },
      { criterionId: 'crit_gk01_3', score: 1.9 },
      { criterionId: 'crit_gk01_4', score: 1.3 },
      { criterionId: 'crit_gk01_5', score: 1.4 },
      { criterionId: 'crit_gk01_6', score: 0.9 },
    ]; // Total = 9.2; avg with grader1 (8) = 8.6
    const correctRes = await teacher.request(
      'POST',
      `/api/rooms/${gkRoomId}/assessments/${teacherAssessmentId}/correct`,
      {
        reason: 'Cộng thêm 0.2 điểm nội dung theo biên bản phản biện.',
        scores: correctedScores,
      }
    );
    assert.equal(correctRes.status, 200);
    assert.equal(correctRes.data.totalScore, 9.2);

    // Verify revision history preserved
    const allAsmts = await teacher.request('GET', `/api/rooms/${gkRoomId}/assessments`);
    const tAsmt = allAsmts.data.assessments.find((a: any) => a.id === teacherAssessmentId);
    assert.equal(tAsmt.revisions.length, 2);

    // Finalize room -> publish results
    const finRes = await teacher.request('POST', `/api/rooms/${gkRoomId}/transition`, {
      targetStatus: 'FINALIZED',
    });
    assert.equal(finRes.status, 200);

    // Student sees finalized results and public feedback, NEVER private teacher notes
    const stuResults = await hs48.request('GET', `/api/rooms/${gkRoomId}/results`);
    assert.equal(stuResults.status, 200);
    assert.equal(stuResults.data.published, true);
    const g1Ranking = stuResults.data.rankings.find((r: any) => r.groupId === 'grp_gk01_1');
    assert.equal(g1Ranking.finalScore, 8.6);
    assert.equal(g1Ranking.rank, 1);

    const stuJsonStr = JSON.stringify(stuResults.data);
    assert.equal(stuJsonStr.includes('BÍ MẬT GIÁO VIÊN'), false);
    assert.equal(stuJsonStr.includes('Nhóm thuyết trình mạch lạc'), true);

    // 5. Exports (.xlsx, .csv, .pdf)
    const xlsxRes = await teacher.request('GET', `/api/rooms/${gkRoomId}/export?format=xlsx`);
    assert.equal(xlsxRes.status, 200);
    assert.ok(Buffer.isBuffer(xlsxRes.data) && xlsxRes.data.length > 1000);

    const csvRes = await teacher.request('GET', `/api/rooms/${gkRoomId}/export?format=csv`);
    assert.equal(csvRes.status, 200);
    assert.ok(csvRes.data.toString('utf-8').includes('Nhóm 1'));

    const pdfRes = await teacher.request('GET', `/api/rooms/${gkRoomId}/export?format=pdf`);
    assert.equal(pdfRes.status, 200);
    assert.equal(pdfRes.data.slice(0, 4).toString(), '%PDF');

    // 6. Disabled user loses access immediately
    const disableRes = await teacher.request('PATCH', `/api/users/${stuLogin.data.user.id}`, {
      isActive: false,
    });
    assert.equal(disableRes.status, 200);
    const kickedMe = await hs48.request('GET', '/api/auth/me');
    assert.equal(kickedMe.status, 401);

    // 6b. Bearer token auth works without cookies (iframe compatibility)
    const bearerLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'Admin@1234' }),
    });
    assert.equal(bearerLogin.status, 200);
    const bearerPayload = (await bearerLogin.json()) as { sessionToken?: string };
    assert.ok(bearerPayload.sessionToken, 'Login response must include sessionToken');

    const overviewWithBearer = await fetch(`${baseUrl}/api/admin/overview`, {
      headers: { Authorization: `Bearer ${bearerPayload.sessionToken}` },
    });
    assert.equal(overviewWithBearer.status, 200);

    const anonSession = await fetch(`${baseUrl}/api/auth/session`);
    assert.equal(anonSession.status, 200);
    const anonPayload = (await anonSession.json()) as { user: unknown };
    assert.equal(anonPayload.user, null);

    // 7. Rate limiter triggers 429 after 20 rapid login attempts
    const brute = makeClient(baseUrl);
    let hit429 = false;
    for (let i = 0; i < 25; i++) {
      const r = await brute.request('POST', '/api/auth/login', {
        username: 'rate_test_user',
        password: 'bad',
      });
      if (r.status === 429) {
        hit429 = true;
        break;
      }
    }
    assert.equal(hit429, true, 'Login rate limiter must return 429 after threshold');
  } finally {
    realtime.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  }
});
