from fastapi.testclient import TestClient
import pytest

from memory_assistant.api import create_app


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv('MEMORY_ASSISTANT_DB_URL', f'sqlite:///{tmp_path / "http.db"}')
    monkeypatch.setenv('MEMORY_ASSISTANT_AUTH_ENABLED', 'true')
    with TestClient(create_app()) as value:
        yield value


def account(client):
    response = client.post('/v1/auth/register', json={
        'email': 'admin@example.com', 'password': 'offline-pass-123', 'display_name': 'Admin'})
    assert response.status_code == 200, response.text
    admin = {'Authorization': 'Bearer ' + response.json()['access_token']}
    created = client.post('/v1/organization/users', headers=admin, json={
        'email': 'member@example.com', 'password': 'offline-pass-123', 'display_name': 'Member'})
    assert created.status_code == 200, created.text
    login = client.post('/v1/auth/login', json={
        'email': 'member@example.com', 'password': 'offline-pass-123'})
    assert login.status_code == 200, login.text
    member = {'Authorization': 'Bearer ' + login.json()['access_token']}
    return admin, member, created.json()['id']


def test_anonymous_access_is_denied(client):
    assert client.get('/health').status_code == 200
    assert client.get('/v1/projects').status_code == 401


def test_accounts_and_organization_roles(client):
    admin, member, _ = account(client)
    assert client.get('/v1/auth/me', headers=member).json()['email'] == 'member@example.com'
    assert client.get('/v1/organization/users', headers=admin).status_code == 200
    assert client.get('/v1/organization/users', headers=member).status_code in (403, 404)
    assert client.post('/v1/auth/login', json={
        'email': 'member@example.com', 'password': 'wrong'}).status_code == 401


def test_department_membership_changes_project_visibility(client):
    admin, member, user_id = account(client)
    department = client.post('/v1/departments', headers=admin, json={'name': 'Engineering'})
    assert department.status_code == 200, department.text
    project = client.post('/v1/projects', headers=admin, json={
        'name': 'Department work', 'visibility': 'department', 'department_id': department.json()['id']})
    assert project.status_code == 200, project.text
    project_id = project.json()['id']
    assert project_id not in [p['id'] for p in client.get('/v1/projects', headers=member).json()['projects']]
    added = client.put(f'/v1/departments/{department.json()["id"]}/members', headers=admin,
                       json={'user_id': user_id, 'role': 'member'})
    assert added.status_code == 200, added.text
    assert project_id in [p['id'] for p in client.get('/v1/projects', headers=member).json()['projects']]


def test_project_members_have_read_access_without_admin_writes(client):
    admin, member, user_id = account(client)
    project = client.post('/v1/projects', headers=admin, json={'name': 'Project work', 'visibility': 'project'})
    assert project.status_code == 200, project.text
    project_id = project.json()['id']
    assert client.get('/v1/documents', headers=member, params={'project_id': project_id}).status_code in (403, 404)
    assert client.put(f'/v1/projects/{project_id}/members', headers=admin,
                      json={'user_id': user_id, 'role': 'member'}).status_code == 200
    assert client.get('/v1/documents', headers=member, params={'project_id': project_id}).status_code == 200
    assert client.post('/v1/documents', headers=member, json={
        'project_id': project_id, 'title': 'Unauthorized', 'content': 'must not be stored'}).status_code in (403, 404)


def test_private_documents_stay_out_of_other_users_answers(client):
    admin, member, _ = account(client)
    project = client.post('/v1/projects', headers=admin, json={'name': 'Company work', 'visibility': 'company'})
    assert project.status_code == 200, project.text
    project_id = project.json()['id']
    for visibility, title, content in [
        ('inherit', 'Handbook', 'The company handbook describes annual leave.'),
        ('private', 'Private memo', 'The Apricot project delivery date is October 12.')]:
        response = client.post('/v1/documents', headers=admin, json={
            'project_id': project_id, 'title': title, 'content': content, 'visibility': visibility})
        assert response.status_code == 200, response.text
    # Query as the owner first to populate any retrieval cache.
    owner = client.post('/v1/chat', headers=admin, json={'project_id': project_id, 'query': 'Apricot project delivery date'})
    assert owner.status_code == 200, owner.text
    assert 'Private memo' in owner.text, owner.json()
    outsider = client.post('/v1/chat', headers=member, json={'project_id': project_id, 'query': 'Apricot project delivery date'})
    assert outsider.status_code == 200, outsider.text
    assert 'Private memo' not in outsider.text
    titles = [item['title'] for item in client.get('/v1/documents', headers=member,
                                                params={'project_id': project_id}).json()['documents']]
    assert titles == ['Handbook']
