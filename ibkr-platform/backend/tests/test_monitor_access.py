import pytest

from app.auth import COOKIE, TENANT_COOKIE
from tests.conftest import OTHER_TENANT


@pytest.mark.parametrize('user_id', ['ADMIN', 'TRADER', 'OUTSIDER', 'SUPER'])
async def test_other_accounts_keep_platform_admin_restricted(client, stores, user_id):
    _, db = stores
    await db.users.update_one({'_id': user_id}, {'$set': {'is_super_admin': True, 'email': f'{user_id.lower()}@test.local'}})
    await db.user_roles.insert_one({'user_id': user_id, 'role': 'SUPER_ADMIN'})
    client.cookies.set(COOKIE, user_id)
    client.cookies.pop(TENANT_COOKIE, None)
    me = (await client.get('/api/v1/auth/me')).json()['data']
    assert me['is_super_admin'] is False
    assert me['role'] == 'TRADER'
    assert (await client.get('/api/v1/accounts')).status_code == 200
    for path in ('/members', '/connections', '/admin/tenants', '/admin/diagnostics'):
        assert (await client.get('/api/v1' + path)).status_code == 403
    expected = 403 if user_id == 'TRADER' else 200
    assert (await client.post('/api/v1/gateway/reconnect', json={})).status_code == expected


@pytest.mark.parametrize('email', ['ekalon.consulting@gmail.com', 'EKALON.CONSULTING@gmail.com'])
async def test_designated_account_has_all_admin_access(client, stores, email):
    _, db = stores
    await db.users.update_one({'_id': 'ADMIN'}, {'$set': {'email': email, 'is_super_admin': False}})
    me = (await client.get('/api/v1/auth/me')).json()['data']
    assert me['is_super_admin'] is True
    assert me['role'] == 'ADMIN'
    for path in ('/members', '/connections', '/admin/tenants', '/admin/diagnostics'):
        assert (await client.get('/api/v1' + path)).status_code == 200
    response = await client.post('/api/v1/tenants/switch', json={'tenant': OTHER_TENANT})
    assert response.status_code == 200
    assert {a['account_id'] for a in (await client.get('/api/v1/accounts')).json()['data']} == {'DU9'}


async def test_admin_revocation_applies_to_existing_session(client, stores):
    _, db = stores
    await db.users.update_one({'_id': 'ADMIN'}, {'$set': {'email': 'ekalon.consulting@gmail.com'}})
    assert (await client.get('/api/v1/members')).status_code == 200
    await db.users.update_one({'_id': 'ADMIN'}, {'$set': {'email': 'former@example.com'}})
    assert (await client.get('/api/v1/members')).status_code == 403
