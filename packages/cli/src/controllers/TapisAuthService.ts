// import axios from 'axios';
// import { Service, Container } from '@n8n/di';
// // Añadimos ProjectRepository y Project a las importaciones
// import { User, UserRepository, RoleRepository, ProjectRepository, Project } from '@n8n/db';

// @Service()
// export class TapisAuthService {
    
//     private readonly TAPIS_API_URL = 'https://portals.tapis.io/v3/oauth2/tokens';

//     async authenticateWithTapis(username: string, password: string): Promise<User | null> {
//         try {
//             // 1. Validar con Tapis
//             await axios.post(this.TAPIS_API_URL, {
//                 username,
//                 password,
//                 grant_type: 'password',
//             }, {
//                 headers: { 'Content-Type': 'application/json' }
//             });

//             const userRepository = Container.get(UserRepository);
//             const roleRepository = Container.get(RoleRepository);
//             const projectRepository = Container.get(ProjectRepository); // Repositorio de proyectos
//             const tapisEmail = `${username}@tacc.utexas.edu`;

//             let user = await userRepository.findOne({ 
//                 where: { email: tapisEmail },
//                 relations: ['role']
//             });

//             if (!user) {
//                 let defaultRole = await roleRepository.findOne({ where: { slug: 'global:owner' } });
//                 if (!defaultRole) defaultRole = await roleRepository.findOne({ where: { slug: 'admin' } });

//                 // 2. Crear el usuario
//                 const newUser = userRepository.create({
//                     email: tapisEmail,
//                     firstName: username,
//                     lastName: '(Tapis)',
//                     password: password, // Asegúrate de pasar el password para que n8n genere el hash
//                     role: defaultRole,
//                     // CAMPOS FALTANTES QUE CAUSAN ERRORES:
//                     settings: { userActivated: true }, // Forzamos activación
//                     personalizationAnswers: { 
//                         version: "v4",
//                         personalization_survey_submitted_at: new Date().toISOString(),
//                     },
//                 } as any);

//                 (newUser as any).active = true;
//                 // Algunos n8n usan 'isPending' o 'isServiceUser'
//                 (newUser as any).isPending = false; 

//                 user = (await userRepository.save(newUser as any)) as any as User;

//                 // 3. CREAR EL PROYECTO PERSONAL (Solución al error 404)
//                 // n8n requiere que cada usuario tenga un proyecto propio para funcionar
//                 const personalProject = projectRepository.create({
//                     name: 'Personal',
//                     type: 'personal',
//                     relations: [
//                         {
//                             userId: user.id,
//                             role: 'project:personalOwner',
//                         },
//                     ],
//                 } as any);

//                 await projectRepository.save(personalProject);
                
//                 console.log(`User ${username} created with personal project.`);
//             }

//             return user;
//         } catch (error) {
//             console.error('Tapis Auth System Error:', error.message);
//             return null;
//         }
//     }
// }


import axios from 'axios';
import { Service, Container } from '@n8n/di';
import { 
    User, 
    UserRepository, 
    RoleRepository, 
    ProjectRepository, 
    ProjectRelationRepository,
    Project
} from '@n8n/db';

@Service()
export class TapisAuthService {
    private readonly TAPIS_API_URL = 'https://portals.tapis.io/v3/oauth2/tokens';

    async authenticateWithTapis(username: string, password: string): Promise<User | null> {
        try {
            // 1. Autenticación con Tapis API
            await axios.post(this.TAPIS_API_URL, {
                username,
                password,
                grant_type: 'password',
            }, {
                headers: { 'Content-Type': 'application/json' }
            });

            const userRepository = Container.get(UserRepository);
            const roleRepository = Container.get(RoleRepository);
            const projectRepository = Container.get(ProjectRepository);
            const projectRelationRepository = Container.get(ProjectRelationRepository);

            const tapisEmail = `${username}@tacc.utexas.edu`;

            // 2. Buscar si el usuario ya existe
            let user = await userRepository.findOne({ 
                where: { email: tapisEmail },
                relations: ['role']
            });

            if (!user) {
                console.log(`[TapisAuth] Creating record for: ${username}`);

                // A. Obtener el rol global:owner (Evita que isPending sea true según la entidad)
                let defaultRole = await roleRepository.findOne({ where: { slug: 'global:owner' } });
                if (!defaultRole) {
                    defaultRole = await roleRepository.findOne({ where: { slug: 'admin' } });
                }

                // B. Crear Usuario siguiendo las reglas de la Entidad User
                const newUser = userRepository.create({
                    email: tapisEmail,
                    firstName: username,
                    lastName: '(Tapis)',
                    password: password, // Al haber password, isPending será false
                    role: defaultRole,
                    roleSlug: defaultRole?.slug || 'global:owner',
                } as any);

                (newUser as any).active = true;
                
                // Metadatos obligatorios para que el Frontend no falle (.map error)
                // (newUser as any).settings = JSON.stringify({ 
                //     userActivated: true,
                //     dashboard: {},
                //     workspaces: { currentWorkspaceId: undefined }
                // });
                // (newUser as any).personalizationAnswers = JSON.stringify({ 
                //     version: "v4",
                //     completed: true,
                //     answers: {} 
                // });

                (newUser as any).settings = { 
                    userActivated: true,
                    dashboard: {},
                    workspaces: { currentWorkspaceId: undefined }
                };

                (newUser as any).personalizationAnswers = { 
                    version: "v4",
                    completed: true,
                    answers: {} 
                };

                user = (await userRepository.save(newUser as any)) as any as User;

                // C. Crear Proyecto Personal con el nombre esperado por createPersonalProjectName()
                // Formato: First Last <email>
                const projectName = `${username} (Tapis) <${tapisEmail}>`;

                const project = (await projectRepository.save(
                    projectRepository.create({
                        name: projectName,
                        type: 'personal',
                        creatorId: user.id, // ASIGNAR EL CREADOR AQUÍ
                    } as any) as any
                )) as any as Project;

                // 2. Crear la Relación (Igual que antes)
                await projectRelationRepository.save(
                    projectRelationRepository.create({
                        userId: user.id,
                        projectId: project.id,
                        role: 'project:personalOwner',
                    } as any) as any
                );

                

                console.log(`[TapisAuth] Project created with ID: ${project.id} and Creator: ${user.id}`);

                // E. Re-cargar para asegurar que el objeto devuelto tiene todas las relaciones
                user = await userRepository.findOne({
                    where: { id: user.id },
                    relations: ['role']
                }) as User;

                // Pequeña espera para asegurar persistencia en SQLite
                await new Promise(resolve => setTimeout(resolve, 150));
            }

            return user;
        } catch (error) {
            console.error('Tapis Auth System Error:', error.response?.data || error.message);
            return null;
        }
    }
}