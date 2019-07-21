import { DynamoDBPutParams, performPut, DynamoDBUpdateParams, performUpdate, DynamoDBGetParams, performGet, DynamoDBDeleteParams, performDelete } from "./database";
import { validate, checkClassPermissions, PermissionLevel, User } from "./security";
import { WebSocketMessages, sendMessageToUser } from "./websocket";
import { APIGatewayEvent } from "aws-lambda";

const randtoken = require('rand-token');

interface UserData {
    fullName: string,
    connectionId?: string,
    id: string,
    permissionLevel: PermissionLevel
}

interface List {
    id: string,
    classId: string,
    listUsers: UserData[],
    observers: UserData[],
    flaggedUsers: {[s: string]: string}
    version: number
}

export interface UserPositionInfo {
  //  version: number,
    index: number,
    observer: boolean,
    listId: string,
    version: number
}

export class ListWrapper {

    id: string

    constructor(list_id: string) {
        validate(list_id, 'string', 'list_id', 32, 32);
        this.id = list_id;
    }

    async getList(projection: string): Promise<List> {
        //Always do consistent read so that lists are in sync
        const getList: DynamoDBGetParams = {
            TableName: process.env.SESSION_TABLE,
            Key: {id: this.id},
            ProjectionExpression: projection,
           // ConsistentRead: true
        }
        return await performGet(getList)
    }
    async addUser(userId: string, connectionId: string, event: APIGatewayEvent): Promise<UserPositionInfo> {
        const listObj = await this.getList('classId');
        const permissionLevel = await checkClassPermissions(userId, listObj.classId,PermissionLevel.Student);
        const getUserFullName: DynamoDBGetParams = {
            TableName: process.env.USER_TABLE,
            Key: {id: userId},
            ProjectionExpression: 'fullName'
        }
        const fullName = (await performGet(getUserFullName) as User).fullName
        const addUser: DynamoDBUpdateParams = {
            TableName: process.env.SESSION_TABLE,
            Key: {id: this.id},
            UpdateExpression: 'set #listUsers = list_append(if_not_exists(#listUsers, :empty_list), :newUsers)    add version :one',
            ExpressionAttributeNames: {
                '#listUsers': permissionLevel === PermissionLevel.Student ? 'listUsers' : 'observers'
            },
            ExpressionAttributeValues: {
                ':newUsers': [{
                    fullName,
                    id: userId,
                    connectionId,
                    permissionLevel
                }],
                ':empty_list': [],
                ':one': 1
            },
            ReturnValues: 'ALL_NEW'
        }
        const newList = await performUpdate(addUser) as {Attributes: List}
        await this.updateUsers(event);
        const data = {totalNumber: -1, flaggedUsers: {}, index: (newList.Attributes[permissionLevel === PermissionLevel.Student ? 'listUsers' : 'observers']).findIndex(value=>value.id === userId), observer: permissionLevel > PermissionLevel.Student, listId: this.id, version: newList.Attributes.version}
        if(data.observer) {
            data.totalNumber = newList.Attributes.listUsers.length;
            data.flaggedUsers = newList.Attributes.flaggedUsers;
        }
        return data;
    }

    //TODO test
    async removeConnectionForUser(userId: string, oldConnectionId: string) {
        const index = await this.getIndexOfUser(userId);
        if(index.index === -1) {
            return; //User has already been removed
        }
        const correctList = index.observer ? 'observers': 'listUsers'
        const updateUser: DynamoDBUpdateParams = {
            TableName: process.env.SESSION_TABLE,
            Key: {id: this.id},
            UpdateExpression: `remove ${correctList}[${index.index}].connectionId   add version :one`,
            ConditionExpression: `${correctList}[${index.index}].connectionId = :valueToRemove`,
            ExpressionAttributeValues: {
                ':valueToRemove': oldConnectionId,
                ':one': 1
            }
        }
        await performUpdate(updateUser);
    }

    async updateConnectionForUser(userId: string, connectionId: string) {
        const index = await this.getIndexOfUser(userId);
        const correctList = index.observer ? 'observers': 'listUsers'
        const updateUser: DynamoDBUpdateParams = {
            TableName: process.env.SESSION_TABLE,
            Key: {id: this.id},
            UpdateExpression: `set ${correctList}[${index.index}].connectionId = :connectionId   add version :one`,
            ConditionExpression: `${correctList}[${index.index}].id = :currentId`,
            ExpressionAttributeValues: {
                ':currentId': userId,
                ':connectionId': connectionId,
                ':one': 1
            },
            ReturnValues: 'ALL_NEW'
        }
        const list = await performUpdate(updateUser) as {Attributes: List};
        console.log({totalNumber: list.Attributes.listUsers.length, flaggedUsers: list.Attributes.flaggedUsers})
        return {totalNumber: list.Attributes.listUsers.length, flaggedUsers: list.Attributes.flaggedUsers};
    }

    async getIndexOfUser(userId: string): Promise<UserPositionInfo>  {
        const info = await this.getList('listUsers, observers, version') as List
        const observerIndex = info.observers.findIndex(value=>value.id === userId)
        if(observerIndex !== -1) {
            return { index: observerIndex, observer: true, listId: this.id, version: info.version}
        }
        const index = info.listUsers.findIndex(value=>value.id === userId)
        return {index, observer: false, listId: this.id, version: info.version}
    }

    async removeUserFromList(userId: string, event: APIGatewayEvent) {
        console.log('Removing user '+userId);
        const index = await this.getIndexOfUser(userId);
        console.log('User index '+JSON.stringify(index))
        const correctList = index.observer ? 'observers': 'listUsers'
        const updateUser: DynamoDBUpdateParams = {
            TableName: process.env.SESSION_TABLE,
            Key: {id: this.id},
            UpdateExpression: `remove ${correctList}[${index.index}]  add version :one`,
            ConditionExpression: `${correctList}[${index.index}].id = :valueToRemove`,
            ExpressionAttributeValues: {
                ':valueToRemove': userId,
                ':one': 1
            },
            ReturnValues: 'ALL_OLD'
        }
        const oldValues = await performUpdate(updateUser) as {Attributes: List};
        console.log(oldValues)
        console.log(oldValues.Attributes[correctList])
        if(oldValues.Attributes[correctList][index.index].connectionId) {
            await sendMessageToUser(userId, oldValues.Attributes[correctList][index.index].connectionId, {listId: this.id},WebSocketMessages.CloseListSession,event,this);
        }
        console.log('Updating users')
        await this.updateUsers(event)
    }

    async helpUser(helperId: string, indexOfUser: number, event: APIGatewayEvent, idOfUser?: string) {
        const listObj = await this.getList('classId');
        await checkClassPermissions(helperId, listObj.classId,PermissionLevel.TA);
        const getNextUserParams: DynamoDBUpdateParams = {
            TableName: process.env.SESSION_TABLE,
            Key: {id: this.id},
            UpdateExpression: `remove listUsers[${indexOfUser}] add version :one`,
            // ConditionExpression: 'version = :currentVersion',
            ExpressionAttributeValues: {
                ':one': 1
            },
            
            ReturnValues: 'ALL_OLD'
        }
        if(idOfUser) {
            getNextUserParams.ConditionExpression = `listUsers[${indexOfUser}].id = :givenId`
            getNextUserParams.ExpressionAttributeValues[':givenId'] = idOfUser;
        }
        const oldUser = await performUpdate(getNextUserParams) as {Attributes: List}
        const currentInfo = await this.getList('observers, listUsers')
        const currentHelperIndex = currentInfo.observers.findIndex(value=>value.id === helperId)
        //Inform User
        await sendMessageToUser(oldUser.Attributes.listUsers[indexOfUser].id, oldUser.Attributes.listUsers[indexOfUser].connectionId, {helperName: currentInfo.observers[currentHelperIndex].fullName, observer: false},WebSocketMessages.HelpEvent,event,this);
        //Inform Helper
        await sendMessageToUser(currentInfo.observers[currentHelperIndex].id, currentInfo.observers[currentHelperIndex].connectionId, {studentName: oldUser.Attributes.listUsers[indexOfUser].fullName, observer: true},WebSocketMessages.HelperEvent,event,this);
        await this.updateUsers(event)
    }

    //This function updates all users and observers of changes in the list
    //This function does not wait
    async updateUsers(event: APIGatewayEvent) {
        const listInfo = await this.getList('listUsers, observers, version, flaggedUsers')
        await Promise.all(listInfo.listUsers.map((user, index)=> {
            return sendMessageToUser(user.id, user.connectionId, {index, observer: false, listId: this.id, version: listInfo.version},WebSocketMessages.SetPosition,event,this);
        }))
        await Promise.all(listInfo.observers.map((user)=> {
           return sendMessageToUser(user.id, user.connectionId, {observer: true, listId: this.id, totalNumber: listInfo.listUsers.length, version: listInfo.version, flaggedUsers: listInfo.flaggedUsers},WebSocketMessages.UpdateListStatus,event,this);
        }))
    }

    async closeList(event: APIGatewayEvent): Promise<void> {
        const listInfo = await this.getList('listUsers, observers, version')
        await Promise.all(listInfo.listUsers.map(async (user)=> {
            await sendMessageToUser(user.id, user.connectionId, {observer: false, listId: this.id, version: listInfo.version},WebSocketMessages.CloseListSession,event,this);
        }))
        await Promise.all(listInfo.observers.map(async (user)=> {
            await sendMessageToUser(user.id, user.connectionId, {observer: true, listId: this.id, version: listInfo.version},WebSocketMessages.CloseListSession,event,this);
        }))
        //Note this does not delete the list reference from the class
        const deleteList: DynamoDBDeleteParams =  {
            TableName: process.env.SESSION_TABLE,
            Key: {id: this.id}
        }   
        await performDelete(deleteList);
    }

    async flagUser(userId: string, studentName: string, message: string, event: APIGatewayEvent): Promise<void> {
        validate(studentName, 'string', 'studentName',1,50)
        validate(message, 'string','message',0,1000);
        const listObj = await this.getList('classId');
        await checkClassPermissions(userId, listObj.classId,PermissionLevel.TA);
        const getTAFullName: DynamoDBGetParams = {
            TableName: process.env.USER_TABLE,
            Key: {id: userId},
            ProjectionExpression: 'fullName'
        }
        const taName = (await performGet(getTAFullName) as User).fullName
        const flagUser: DynamoDBUpdateParams = {
            TableName: process.env.SESSION_TABLE,
            Key: {id: this.id},
            UpdateExpression: 'set #listUsers.#studentName = :message    add version :one',
            ExpressionAttributeNames: {
                '#listUsers': 'flaggedUsers',
                '#studentName': studentName
            },
            ExpressionAttributeValues: {
                ':message': 'TA name: '+taName+', Message: '+message,
                ':one': 1
            }
        }
        await performUpdate(flagUser) as {Attributes: List}
        await sendMessageToUser(userId, event.requestContext.connectionId, {studentName, message, observer: true, flagged: true},WebSocketMessages.FlagRecorded,event,this);
        await this.updateUsers(event);
    }

    async helpFlagUser(userId: string, studentName: string, message: string, event: APIGatewayEvent): Promise<void> {
        validate(studentName, 'string', 'studentName',1,50)
        validate(message, 'string','message',0,1000);
        const listObj = await this.getList('classId');
        await checkClassPermissions(userId, listObj.classId,PermissionLevel.Professor);
        const unFlagUser: DynamoDBUpdateParams = {
            TableName: process.env.SESSION_TABLE,
            Key: {id: this.id},
            UpdateExpression: 'remove #listUsers.#studentName    add version :one',
            ExpressionAttributeNames: {
                '#listUsers': 'flaggedUsers',
                '#studentName': studentName
            },
            ConditionExpression: '#listUsers.#studentName = :message',
            ExpressionAttributeValues: {
                ':message': message,
                ':one': 1
            }
        }
        await performUpdate(unFlagUser) as {Attributes: List}
        await sendMessageToUser(userId, event.requestContext.connectionId, {studentName, message, observer: true, flagged: true},WebSocketMessages.HelperEvent,event,this);
        await this.updateUsers(event);
    }
}

export const createList = async (classId: string): Promise<List> => {
    const newList: List = {
        id: randtoken.generate(32),
        classId,
        listUsers: [],
        observers: [],
        flaggedUsers: {},
        version: 0
    }
    const createListParams: DynamoDBPutParams = {
        TableName: process.env.SESSION_TABLE,
        Item: newList
    }
    await performPut(createListParams);
    return newList;
}