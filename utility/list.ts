import { DynamoDBPutParams, performPut, DynamoDBUpdateParams, performUpdate, DynamoDBGetParams, performGet, DynamoDBDeleteParams, performDelete} from "./database";
import { validate, checkClassPermissions, PermissionLevel, User, sendEmail } from "./security";
import { WebSocketMessages, sendMessageToUser } from "./websocket";
import { APIGatewayEvent } from "aws-lambda";
import { GeneratedError, ErrorTypes } from "./responses";

const randtoken = require('rand-token');

const timeBetweenCalls = 1000;

interface UserData {
    fullName: string,
    connectionId?: string,
    id: string,
    permissionLevel: PermissionLevel,
    startTime: number,
    timedEventTime?: number,
    helpedStudents?: number,
    flaggedStudents?: number,
    helpedFlaggedStudents?: number
}

interface List {
    id: string,
    classId: string,
    listUsers: UserData[],
    observers: UserData[],
    flaggedUsers: {[s: string]: string}
    version: number, 
    creatorId: string,
    listName: string,
    totalStudentsHelped: number,
    totalWaitTime: number
}

export interface UserPositionInfo {
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
            //ConsistentRead: true
        }
        return await performGet(getList)
    }
    async addUser(userId: string, connectionId: string, event: APIGatewayEvent): Promise<UserPositionInfo> {
        console.log('Adding user '+ userId + ' to list ' + this.id);
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
                    permissionLevel,
                    startTime: Date.now()
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

    async getUserPermissionLevel(userId: string, required: PermissionLevel, helpingUser: boolean, flaggingUser: boolean, helpingFlaggedUser: boolean) {
            const list = await this.getList('listUsers, observers');
            const listIndex = list.listUsers.findIndex(value=>value.id === userId);
            const observerIndex = list.observers.findIndex(value=>value.id === userId);
            if(listIndex > -1) {
                if(list.listUsers[listIndex].permissionLevel < required) {
                    throw new GeneratedError(ErrorTypes.InvalidPermissions);
                }
            } else if(observerIndex > -1) {
                if(list.observers[observerIndex].permissionLevel < required) {
                    throw new GeneratedError(ErrorTypes.InvalidPermissions);
                }
            } else {
                throw new GeneratedError(ErrorTypes.InvalidPermissions);
            }
            
            const updateUser: DynamoDBUpdateParams = {
                TableName: process.env.SESSION_TABLE,
                Key: {id: this.id},
                UpdateExpression: `set #listName[${Math.max(listIndex,observerIndex)}].timedEventTime = :currentTime` +(helpingUser ? `, #listName[${Math.max(listIndex,observerIndex)}].helpedStudents = if_not_exists(#listName[${Math.max(listIndex,observerIndex)}].helpedStudents, :start) + :one`:'')+(flaggingUser ? `, #listName[${Math.max(listIndex,observerIndex)}].flaggedStudents = if_not_exists(#listName[${Math.max(listIndex,observerIndex)}].flaggedStudents, :start) + :one`:'')+(helpingFlaggedUser ? `, #listName[${Math.max(listIndex,observerIndex)}].helpedFlaggedStudents = if_not_exists(#listName[${Math.max(listIndex,observerIndex)}].helpedFlaggedStudents, :start) + :one`:''),
                ConditionExpression: `attribute_not_exists(#listName[${Math.max(listIndex,observerIndex)}].timedEventTime) or #listName[${Math.max(listIndex,observerIndex)}].timedEventTime < :cutoffTime`,
                ExpressionAttributeNames: {
                    '#listName': Math.max(listIndex,observerIndex) === observerIndex ? 'observers': 'listUsers'
                },
                ExpressionAttributeValues: {
                    ':currentTime' : Date.now(),
                    ':cutoffTime': Date.now() - timeBetweenCalls,
                    ':start': 0,
                    ':one': 1
                }
            }
            try {
                await performUpdate(updateUser);
            } catch(e) {
                throw new GeneratedError(ErrorTypes.TooManyRequests);
            }
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
        console.log('Removing user id '+userId + ' from the list '+this.id);
        const index = await this.getIndexOfUser(userId);
        const correctList = index.observer ? 'observers': 'listUsers'
        if(index.observer) {
            return; //Don't remove TAs from the list, even if they request it, to preserve records
        }
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
        if(oldValues.Attributes[correctList][index.index].connectionId) {
            await sendMessageToUser(userId, oldValues.Attributes[correctList][index.index].connectionId, {listId: this.id},WebSocketMessages.CloseListSession,event,this);
        }
        await this.updateUsers(event)
    }

    async helpUser(helperId: string, indexOfUser: number, event: APIGatewayEvent, idOfUser?: string) {
        await this.getUserPermissionLevel(helperId, PermissionLevel.TA,true,false,false);
        const addStartTime: DynamoDBUpdateParams = {
            TableName: process.env.SESSION_TABLE,
            Key: {id: this.id},
            UpdateExpression: `set totalWaitTime = totalWaitTime - listUsers[${indexOfUser}].startTime`
        }
        await performUpdate(addStartTime)
        const getNextUserParams: DynamoDBUpdateParams = {
            TableName: process.env.SESSION_TABLE,
            Key: {id: this.id},
            UpdateExpression: `remove listUsers[${indexOfUser}] add version :one,totalStudentsHelped :one set totalWaitTime  = totalWaitTime + :time`,
            // ConditionExpression: 'version = :currentVersion',
            ExpressionAttributeValues: {
                ':one': 1,
                ':time': Date.now()
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
        console.log('List '+this.id+' Helping User: '+oldUser.Attributes.listUsers[indexOfUser].id+' with name ' + oldUser.Attributes.listUsers[indexOfUser].fullName + ' by TA '+currentInfo.observers[currentHelperIndex].id+ ' with name '+currentInfo.observers[currentHelperIndex].fullName);
        //Inform User
        await sendMessageToUser(oldUser.Attributes.listUsers[indexOfUser].id, oldUser.Attributes.listUsers[indexOfUser].connectionId, {helperName: currentInfo.observers[currentHelperIndex].fullName, observer: false},WebSocketMessages.HelpEvent,event,this);
        //Inform Helper
        await sendMessageToUser(currentInfo.observers[currentHelperIndex].id, currentInfo.observers[currentHelperIndex].connectionId, {studentName: oldUser.Attributes.listUsers[indexOfUser].fullName, observer: true},WebSocketMessages.HelperEvent,event,this);
        await this.updateUsers(event)
    }

    async getFullOverview(requesterId: string, event: APIGatewayEvent) {
        const listObj = await this.getList('classId');
        await checkClassPermissions(requesterId, listObj.classId,PermissionLevel.Professor);
        const users = await this.getList('observers, listUsers');
        const currentHelperIndex = users.observers.findIndex(value=>value.id === requesterId);
        await sendMessageToUser(users.observers[currentHelperIndex].id, users.observers[currentHelperIndex].connectionId, {tas: users.observers, users: users.listUsers, observer: true},WebSocketMessages.FullInfo,event,this);
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
        await this.sendReportEmail();
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
        await this.getUserPermissionLevel(userId, PermissionLevel.TA,false, true,false);
        const getTAFullName: DynamoDBGetParams = {
            TableName: process.env.USER_TABLE,
            Key: {id: userId},
            ProjectionExpression: 'fullName'
        }
        const time = (new Date()).toLocaleString('en-US', { hour: 'numeric', minute: 'numeric', hour12: true, timeZone: 'America/Chicago' }).padStart(8,' ');

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
                ':message': 'Time: '+time+', TA name: '+taName+', Message: '+message,
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
        await this.getUserPermissionLevel(userId, PermissionLevel.TA,false,false,true);
        console.log('Helping flaged user '+studentName+ ' from TA with Id '+userId);
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

    async sendReportEmail(): Promise<void> {
        const list = await this.getList('creatorId, observers, listName, totalStudentsHelped, totalWaitTime');
        const userParams: DynamoDBGetParams = {
            TableName: process.env.USER_TABLE,
            Key: {id: list.creatorId},
            ProjectionExpression: "id, username"
        };
        const creator = await performGet(userParams);
        let textBody = `
            Report for ${list.listName} on ${new Date().toLocaleDateString('en-us',{ weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })} at ${new Date().toLocaleString('en-us',{ hour: 'numeric', minute: 'numeric', hour12: true, timeZone: 'America/Chicago' })},

            The following TAs helped/demoed, flagged, or helped a flagged student at least once:

        `;
        textBody+=`The average wait time was ${millisToMinutesAndSeconds(list.totalWaitTime/list.totalStudentsHelped)} and the total number of students helped was ${list.totalStudentsHelped}`;
        for(let tas of list.observers) {
            textBody += `${tas.fullName} helped ${tas.helpedStudents ? tas.helpedStudents : 0} student(s), flagged ${tas.flaggedStudents ? tas.flaggedStudents : 0} student(s), and helped flagged students ${tas.helpedFlaggedStudents ? tas.helpedFlaggedStudents : 0} time(s)\n`
            textBody += `This TA first joined the list at ${new Date(tas.startTime).toLocaleTimeString('en-us',{ hour: 'numeric', minute: 'numeric', hour12: true, timeZone: 'America/Chicago' })} and helped/flagged their last user at ${tas.timedEventTime ? new Date(tas.timedEventTime).toLocaleTimeString('en-us',{ hour: 'numeric', minute: 'numeric', hour12: true, timeZone: 'America/Chicago' }): 'Undefined'}\n\n`
        }
        let htmlBody = `
        <!DOCTYPE html>
        <html>
            <head>
            </head>
            <body>
                <h3>Report for ${list.listName} on ${new Date().toLocaleDateString('en-us',{ weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}  at ${new Date().toLocaleString('en-us',{ hour: 'numeric', minute: 'numeric', hour12: true, timeZone: 'America/Chicago' })}</h3>
                <p>The following TAs helped/demoed, flagged, or helped a flagged student at least once:</p>`;
            htmlBody+=`<p> The average wait time was ${millisToMinutesAndSeconds(list.totalWaitTime/list.totalStudentsHelped)} and the total number of students helped was ${list.totalStudentsHelped}</p>`
            htmlBody+=`
                <table>
                    <tr><th>Name</th><th>Helped Students</th><th>Flagged Students</th><th>Helped Flagged Students</th><th>Start Time</th><th>Last Action Time</th></tr>`;
            for(let tas of list.observers) {
                htmlBody += `<tr><td>${tas.fullName}</td><td>${tas.helpedStudents ? tas.helpedStudents : 0}</td><td>${tas.flaggedStudents ? tas.flaggedStudents : 0}</td><td>${tas.helpedFlaggedStudents ? tas.helpedFlaggedStudents : 0}</td>`
                htmlBody += `<td>${new Date(tas.startTime).toLocaleTimeString('en-us',{ hour: 'numeric', minute: 'numeric', hour12: true, timeZone: 'America/Chicago' })}</td><td>${tas.timedEventTime ? new Date(tas.timedEventTime).toLocaleTimeString('en-us',{ hour: 'numeric', minute: 'numeric', hour12: true, timeZone: 'America/Chicago' }): 'Undefined'}</td></tr>`
            }
        
            
        htmlBody+=`
                </table>
            </body>
        </html>
        `
        await sendEmail(creator.username, `Report for `+list.listName,textBody,htmlBody)
    }
    
}

function millisToMinutesAndSeconds(millis) {
    var minutes = Math.floor(millis / 60000);
    var seconds: any = ((millis % 60000) / 1000).toFixed(0);
    return minutes + ":" + (seconds < 10 ? '0' : '') + seconds;
  }

export const createList = async (classId: string, creatorId: string, listName: string): Promise<List> => {
    const newList: List = {
        id: randtoken.generate(32),
        classId,
        listUsers: [],
        observers: [],
        flaggedUsers: {},
        version: 0,
        creatorId,
        listName,
        totalWaitTime: 0,
        totalStudentsHelped: 0
    }
    const createListParams: DynamoDBPutParams = {
        TableName: process.env.SESSION_TABLE,
        Item: newList
    }
    await performPut(createListParams);
    return newList;
}