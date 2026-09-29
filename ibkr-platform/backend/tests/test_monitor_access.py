import pytest

from app.auth import COOKIE, TENANT_COOKIE
from tests.conftest import OTHER_TENANT

# Two levels of administration. A tenant's OWNER and ADMIN members run that tenant: its members,
# connections, account names and diagnostics. Only the designated Ekalon login is a platform
# super-admin, which additionally sees every tenant and the tenant list itself. A super-admin
# flag written straight into the users collection is ignored; the email is what counts.

TENANT_ADMIN_PATHS = ('/members', '/connections', '/admin/diagnostics')


@pytest.mark.parametrize('user_id', ['ADMIN', 'TRADER', 'OUTSIDER', 'SUPER'])
async def test_a_database_flag_does_not_make_a_platform_admin(client, stores, user_id):
    _, db = stores
    await db.users.update_one({'_id': user_id}, {'$set': {'is_super_admin': True, 'email': f'{user_id.lower()}@test.local'}})
    await db.user_roles.insert_one({'user_id': user_id, 'role': 'SUPER_ADMIN'})
    client.cookies.set(COOKIE, user_id)
    client.cookies.pop(TENANT_COOKIE, None)
    me = (await client.get('/api/v1/auth/me')).json()['data']
    assert me['is_super_admin'] is False
    assert (await client.get('/api/v1/accounts')).status_code == 200
    assert (await client.get('/api/v1/admin/tenants')).status_code == 403, 'the tenant list is platform-only'
    owner = user_id != 'TRADER'
    assert me['role'] == ('ADMIN' if owner else 'TRADER')
    for path in TENANT_ADMIN_PATHS:
        assert (await client.get('/api/v1' + path)).status_code == (200 if owner else 403), path
    assert (await client.post('/api/v1/gateway/reconnect', json={})).status_code == (200 if owner else 403)

async def test_a_tenant_owner_administers_only_their_own_tenant(client, stores):
    client.cookies.set(COOKIE, 'OUTSIDER')
    client.cookies.pop(TENANT_COOKIE, None)
    assert (await client.get('/api/v1/members')).status_code == 200
    assert (await client.post('/api/v1/tenants/switch', json={'tenant': 'sattvic'})).status_code == 403
    client.cookies.set(TENANT_COOKIE, 'sattvic')
    assert (await client.get('/api/v1/members')).status_code == 403

@pytest.mark.parametrize('email', ['ekalon.consulting@gmail.com', 'EKALON.CONSULTING@gmail.com'])
async def test_designated_account_has_all_admin_access(client, stores, email):
    _, db = stores
    await db.users.update_one({'_id': 'ADMIN'}, {'$set': {'email': email, 'is_super_admin': False}})
    me = (await client.get('/api/v1/auth/me')).json()['data']
    assert me['is_super_admin'] is True
    assert me['role'] == 'ADMIN'
    for path in (*TENANT_ADMIN_PATHS, '/admin/tenants'):
        assert (await client.get('/api/v1' + path)).status_code == 200
    response = await client.post('/api/v1/tenants/switch', json={'tenant': OTHER_TENANT})
    assert response.status_code == 200
    assert {a['account_id'] for a in (await client.get('/api/v1/accounts')).json()['data']} == {'DU9'}

async def test_platform_admin_revocation_applies_to_existing_session(client, stores):
    _, db = stores
    await db.users.update_one({'_id': 'ADMIN'}, {'$set': {'email': 'ekalon.consulting@gmail.com'}})
    assert (await client.get('/api/v1/admin/tenants')).status_code == 200
    await db.users.update_one({'_id': 'ADMIN'}, {'$set': {'email': 'former@example.com'}})
    assert (await client.get('/api/v1/admin/tenants')).status_code == 403
    assert (await client.get('/api/v1/members')).status_code == 200, 'still the tenant owner'
