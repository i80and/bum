import * as media from './media'

const EMPTY_IMAGE = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP'

class Player {
    playing: media.Song
    paused: media.Song

    element: HTMLAudioElement
    library: media.MediaLibrary
    playlist: media.Song[]

    onplay: ()=>void

    constructor(library: media.MediaLibrary) {
        this.playing = null
        this.paused = null
        this.library = library
        this.playlist = []
        this.onplay = () => {}

        this._initElement()
    }

    play(songs: media.Song[]) {
        this.playlist = songs.reverse()
        this.doPlay()
    }

    togglePause() {
        if(this.paused) {
            this.element.play()
            this.playing = this.paused
            this.paused = null
            this.onplay()
            return
        }

        this.element.pause()
        this.paused = this.playing
        this.playing = null
        this.onplay()
    }

    skip() {
        this.doPlay()
    }

    shuffle() {
        this.library.shuffle().then((ids) => ids.map((id) => {
            return this.library.getSong(id)
        })).then((songs) => {
            this.play(songs)
        })
    }

    doPlay() {
        this.paused = null
        this.playing = null
        if(this.playlist.length === 0) {
            this.onplay()

            // Don't pause an errored stream. This can cause a nasty
            // error loop, where pausing triggers reparsing bad input.
            if(!this.element.error) {
                this.element.pause()
            }
            return
        }

        const song = this.playlist.pop()
        this.playing = song
        this.element.src = this.library.songUrl(song)
        this.element.play()

        this.onplay()
    }

    _initElement(): void {
        this.element = document.createElement('audio')
        this.element.controls = false

        this.element.onended = () => {
            this.doPlay()
        }

        this.element.onerror = () => {
            const id = this.playing? this.playing.id : 'unknown'
            console.error(`Error playing ${id}`)
            this.doPlay()
        }
    }
}

class CoverSwitcher {
    elements: HTMLImageElement[]
    curCover: Blob
    cur: number

    constructor(elements: HTMLImageElement[]) {
        this.elements = elements.slice(0, 2)
        this.curCover = null
        this.cur = 0
    }

    switch(data: Blob) {
        if(data === this.curCover) { return }

        this.curCover = data

        this.currentElement.classList.add('old')
        this.cur = (this.cur + 1) % 2
        this.currentElement.classList.remove('old')

        if(data === null) {
            this.currentElement.src = EMPTY_IMAGE
            return
        }

        this.currentElement.src = URL.createObjectURL(data)
    }

    get currentElement() {
        return this.elements[this.cur]
    }
}

class AlbumsView {
    root: HTMLElement
    library: media.MediaLibrary
    shown: boolean

    onPlay: (songs: media.Song[]) => void
    onShuffle: () => void

    constructor(root: HTMLElement, library: media.MediaLibrary) {
        this.root = root
        this.shown = false
        this.library = library

        this.onPlay = () => {}
        this.onShuffle = () => {}
    }

    setPlayer(player: Player): void {
        this.onPlay = (songs) => { player.play(songs) }
        this.onShuffle = () => { player.shuffle() }
    }

    hide(): void {
        this.root.innerHTML = ''
        this.shown = false
        return
    }

    toggle(): void {
        if(this.shown) {
            this.hide()
            return
        }

        this.shown = true
        this.library.getAlbums().then((albums) => {
            albums.sort((a, b) => { return a.compare(b) })
            this.root.innerHTML = ''

            // Add the "shuffle" entry
            {
                const el = document.createElement('div')
                el.addEventListener('click', () => { this.onShuffle() })

                const label = document.createElement('span')
                label.className = 'fa fa-random'
                label.title = 'Shuffle'

                el.appendChild(label)
                this.root.appendChild(el)
            }

            for(let curAlbum of albums) {
                const el = document.createElement('div')
                const album = curAlbum
                el.addEventListener('click', () => {
                    const songs = album.tracks.map((id) => {
                        return this.library.getSong(id)
                    })

                    this.onPlay(songs)
                    this.hide()
                })

                album.getThumbnail(this.library).then((blob: Blob) => {
                    if(blob !== null) {
                        el.innerHTML = ''
                        el.style.backgroundImage = `url(${URL.createObjectURL(blob) })`
                        el.style.backgroundColor = 'transparent'
                    } else {
                        const artistElement = document.createElement('div')
                        const titleElement = document.createElement('div')

                        artistElement.textContent = album.albumArtist
                        titleElement.textContent = album.title

                        el.appendChild(artistElement)
                        el.appendChild(titleElement)
                        el.style.backgroundImage = ''
                    }

                })

                this.root.appendChild(el)
            }
        })
    }
}

function main() {
    const playButton = document.getElementById('play-button')
    const skipButton = document.getElementById('skip-button')
    const labelElement = document.getElementById('caption')

    const coverSwitcher = new CoverSwitcher(<HTMLImageElement[]>Array.from(document.getElementsByClassName('cover')))
    const library = new media.MediaLibrary('/api')
    const player = new Player(library)

    library.refresh()

    player.onplay = () => {
        const song = player.playing || player.paused

        if(song) {
            labelElement.textContent = `${song.artist} - ${song.title}`

            library.getAlbumBySong(song.id).then((album: media.Album) => {
                return album.getCover(library)
            }).then((cover: Blob) => {
                coverSwitcher.switch(cover)
            })
        } else {
            coverSwitcher.switch(null)
            labelElement.textContent = ''
        }

        if(player.playing) {
            playButton.className = 'fa fa-pause playing'
        } else {
            playButton.className = 'fa fa-play'
        }
    }

    playButton.addEventListener('click', function() {
        if(player.playing) {
            player.togglePause()
        } else if(player.paused) {
            player.togglePause()
        } else {
            player.shuffle()
        }
    })

    skipButton.addEventListener('click', function() {
        player.skip()
    })

    const albumsButton = document.getElementById('albums-button')
    const albumsList = document.getElementById('album-list')
    const albumsView = new AlbumsView(albumsList, library)
    albumsView.setPlayer(player)
    albumsButton.addEventListener('click', function() {
        albumsView.toggle()
    })
}

window.addEventListener('DOMContentLoaded', function() {
    main()
})
